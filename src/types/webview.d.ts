// The Electron <webview> element, as used by the built-in browser.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ForgeWebviewElement extends HTMLElement {
  src: string;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string }>;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<ForgeWebviewElement>, ForgeWebviewElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}
export {};
