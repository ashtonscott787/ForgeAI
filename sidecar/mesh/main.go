// forge-mesh is the networking sidecar.
//
// Why a Go sidecar beside a Rust core: tsnet embeds a complete Tailscale node
// INSIDE this process using a userspace TCP/IP stack. That means no root, no
// system daemon, no virtual network interface, no WinTUN driver on Windows and
// no NetworkExtension entitlement on macOS. For a product whose first promise
// is "nothing to install", that is the difference between shipping and not.
//
// The trade: tsnet is a userspace node, so only traffic that goes through
// this process crosses the mesh. That is exactly what Forge needs — the
// llama.cpp RPC streams and the control channel, nothing else. We are not
// trying to be a VPN for the whole machine.
//
// Sovereignty hedge: ControlURL is configurable. Point it at a self-hosted
// Headscale and no Tailscale-operated coordination server is involved.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

var (
	hostname   = flag.String("hostname", "", "mesh hostname for this machine")
	stateDir   = flag.String("state", "", "directory for this node's identity and state")
	controlURL = flag.String("control-url", "", "coordination server; empty means Tailscale's, set this to a self-hosted Headscale for full sovereignty")
	authKey    = flag.String("authkey", "", "pre-authorised key; when empty an interactive login URL is emitted on stdout as JSON")
	ctrlAddr   = flag.String("control-addr", "127.0.0.1:8731", "loopback control API for the Forge core")
	exposeAddr = flag.String("expose", "", "local address to publish on the mesh, e.g. 127.0.0.1:50052 for rpc-server")
	exposePort = flag.Int("expose-port", 50052, "port to listen on over the mesh")
)

// event is the line protocol spoken to the Rust core over stdout: one JSON
// object per line. Keeping it line-delimited means the core never has to parse
// a stream or guess at framing.
type event struct {
	Kind    string `json:"kind"`
	Message string `json:"message,omitempty"`
	AuthURL string `json:"auth_url,omitempty"`
	Self    string `json:"self,omitempty"`
	IPv4    string `json:"ipv4,omitempty"`
}

func emit(e event) {
	b, _ := json.Marshal(e)
	fmt.Println(string(b))
}

type peer struct {
	Name   string  `json:"name"`
	Addr   string  `json:"addr"`
	Online bool    `json:"online"`
	OS     string  `json:"os"`
	RTTms  float64 `json:"rtt_ms"`
}

func main() {
	flag.Parse()

	if *stateDir == "" {
		d, err := os.UserConfigDir()
		if err != nil {
			fatal("cannot locate a config directory: %v", err)
		}
		*stateDir = filepath.Join(d, "ForgeAI", "mesh")
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		fatal("cannot create state directory: %v", err)
	}
	if *hostname == "" {
		h, _ := os.Hostname()
		*hostname = "forge-" + sanitise(h)
	}

	srv := &tsnet.Server{
		Hostname:   *hostname,
		Dir:        *stateDir,
		AuthKey:    *authKey,
		ControlURL: *controlURL,
		// Routed to stdout as structured events, so the desktop UI can show
		// "waiting for you to approve this machine" instead of a blank spinner.
		UserLogf: func(format string, args ...any) {
			msg := fmt.Sprintf(format, args...)
			if url := extractAuthURL(msg); url != "" {
				emit(event{Kind: "auth_required", AuthURL: url})
				return
			}
			emit(event{Kind: "log", Message: msg})
		},
		Logf: func(string, ...any) {}, // internal chatter stays internal
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	st, err := srv.Up(ctx)
	if err != nil {
		fatal("mesh did not come up: %v", err)
	}
	v4 := ""
	if len(st.TailscaleIPs) > 0 {
		v4 = st.TailscaleIPs[0].String()
	}
	emit(event{Kind: "up", Self: st.Self.DNSName, IPv4: v4})

	// Publish the local rpc-server on the mesh, if asked. This is the only
	// thing that ever crosses machines, and it crosses encrypted.
	if *exposeAddr != "" {
		go publish(srv, *exposePort, *exposeAddr)
	}

	// Loopback control API for the Rust core.
	serveControl(ctx, srv)
}

// publish accepts mesh connections on meshPort and splices them to a local
// address. rpc-server has no authentication or encryption of its own, so it is
// bound to loopback and only ever reachable through here.
func publish(srv *tsnet.Server, meshPort int, local string) {
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", meshPort))
	if err != nil {
		emit(event{Kind: "error", Message: fmt.Sprintf("cannot listen on mesh port %d: %v", meshPort, err)})
		return
	}
	emit(event{Kind: "published", Message: fmt.Sprintf("mesh :%d -> %s", meshPort, local)})
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go splice(c, local)
	}
}

func splice(remote net.Conn, local string) {
	defer remote.Close()
	up, err := net.DialTimeout("tcp", local, 5*time.Second)
	if err != nil {
		emit(event{Kind: "error", Message: "local runtime not reachable: " + err.Error()})
		return
	}
	defer up.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); io.Copy(up, remote) }()
	go func() { defer wg.Done(); io.Copy(remote, up) }()
	wg.Wait()
}

// serveControl exposes the mesh to the Forge core over loopback only.
//
//	GET  /status            — is the mesh up, what is this node called
//	GET  /peers             — approved peers and measured RTT
//	POST /forward?peer=..&port=.. — open a local port that tunnels to a peer
func serveControl(ctx context.Context, srv *tsnet.Server) {
	lc, err := srv.LocalClient()
	if err != nil {
		fatal("no local client: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		st, err := lc.Status(r.Context())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, map[string]any{
			"up":       st.BackendState == "Running",
			"state":    st.BackendState,
			"self":     st.Self.DNSName,
			"control":  *controlURL,
			"hostname": *hostname,
		})
	})

	mux.HandleFunc("/peers", func(w http.ResponseWriter, r *http.Request) {
		st, err := lc.Status(r.Context())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		out := make([]peer, 0, len(st.Peer))
		for _, p := range st.Peer {
			addr := ""
			if len(p.TailscaleIPs) > 0 {
				addr = p.TailscaleIPs[0].String()
			}
			out = append(out, peer{
				Name:   p.DNSName,
				Addr:   addr,
				Online: p.Online,
				OS:     p.OS,
				RTTms:  0, // filled by the core's own measurement; see note below
			})
		}
		writeJSON(w, out)
	})

	// Open a loopback port that tunnels to a peer's published rpc-server.
	// The core hands llama-server a plain 127.0.0.1 address and never learns
	// that the layers are on another continent.
	mux.HandleFunc("/forward", func(w http.ResponseWriter, r *http.Request) {
		peerHost := r.URL.Query().Get("peer")
		port := r.URL.Query().Get("port")
		if peerHost == "" || port == "" {
			http.Error(w, "peer and port are required", 400)
			return
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		target := net.JoinHostPort(peerHost, port)
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go func(c net.Conn) {
					defer c.Close()
					up, err := srv.Dial(ctx, "tcp", target)
					if err != nil {
						emit(event{Kind: "error", Message: "dial " + target + ": " + err.Error()})
						return
					}
					defer up.Close()
					var wg sync.WaitGroup
					wg.Add(2)
					go func() { defer wg.Done(); io.Copy(up, c) }()
					go func() { defer wg.Done(); io.Copy(c, up) }()
					wg.Wait()
				}(c)
			}
		}()
		writeJSON(w, map[string]string{"local": ln.Addr().String(), "target": target})
	})

	emit(event{Kind: "control_ready", Message: *ctrlAddr})
	s := &http.Server{Addr: *ctrlAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := s.ListenAndServe(); err != nil {
		fatal("control API stopped: %v", err)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func extractAuthURL(msg string) string {
	for _, f := range strings.Fields(msg) {
		if strings.HasPrefix(f, "https://") && strings.Contains(f, "/a/") {
			return f
		}
	}
	return ""
}

func sanitise(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '.':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "machine"
	}
	return out
}

func fatal(format string, args ...any) {
	emit(event{Kind: "fatal", Message: fmt.Sprintf(format, args...)})
	log.Fatalf(format, args...)
}
