import { useEffect, useState } from "react";
import { api, fmtBytes, type Health, type LinkReadiness, type MachineCapability } from "../lib/ipc";

export function Setup({ self, health }: { self: MachineCapability | null; health: Health | null }) {
  const [cpu, setCpu] = useState("");
  const [link, setLink] = useState<LinkReadiness | null>(null);

  useEffect(() => {
    api.cpuLabel().then(setCpu).catch(() => undefined);
    api.linkReadiness().then(setLink).catch(() => undefined);
  }, []);

  const backendLabel: Record<string, string> = {
    metal: "Metal (Apple GPU)",
    cuda: "CUDA (NVIDIA)",
    vulkan: "Vulkan",
    cpu: "CPU only",
  };

  return (
    <>
      <div className="phead">
        <h2>Hardware</h2>
        <p>Detected on this machine. Nothing is sent anywhere.</p>
      </div>
      <div className="scroll">
        <div className="pbody">
          <div className="detect">
            {self ? (
              <>
                <Row k="Machine" v={self.name} x={self.os} />
                <Row k="Processor" v={cpu || "—"} x="" />
                <Row
                  k="Acceleration"
                  v={backendLabel[self.backend] ?? self.backend}
                  x={self.unified_memory ? "unified memory" : self.vram_bytes ? `${fmtBytes(self.vram_bytes)} VRAM` : ""}
                />
                <Row k="Memory" v={fmtBytes(self.ram_bytes)} x={`${fmtBytes(self.usable_model_bytes)} usable for models`} />
                <Row k="Runtime" v={health?.runtime_id ?? "—"} x={health?.runtime_available ? "bundled" : "MISSING from this build"} />
                <Row k="Models folder" v={health?.models_dir ?? "—"} x="" />
              </>
            ) : (
              <Row k="Core" v="Not reachable" x="this view needs the desktop app" />
            )}
          </div>

          <div className="panel">
            <div className="panel-h">
              <span className="t">Linking other computers</span>
              <span className="badge">Not enabled in 0.1</span>
            </div>
            <div className="panel-b">
              {link && (
                <>
                  <div className="kvrow">
                    <span className="k">Mesh interface detected</span>
                    <span className="v">
                      {link.mesh_interface_detected ? `yes · ${link.mesh_address}` : "no"}
                    </span>
                  </div>
                  <div className="kvrow">
                    <span className="k">Distributed inference</span>
                    <span className="v">off</span>
                  </div>
                  <p className="explain">{link.explanation}</p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ k, v, x }: { k: string; v: string; x: string }) {
  return (
    <div className="drow">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      <span className="x">{x}</span>
    </div>
  );
}
