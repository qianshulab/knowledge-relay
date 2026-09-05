import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import Brand from "./Brand";

type Props = { children: ReactNode };
type State = { failed: boolean };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Knowledge Relay interface error", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-crash-screen">
        <Brand />
        <section>
          <span><AlertTriangle size={24} /></span>
          <div className="eyebrow">INTERFACE RECOVERY</div>
          <h1>这个页面暂时没有正确打开</h1>
          <p>知识数据仍然安全保存在服务端。重新载入界面通常就能恢复。</p>
          <button className="button button-primary button-lg" type="button" onClick={() => window.location.reload()}><RefreshCw size={17} />重新载入界面</button>
        </section>
      </main>
    );
  }
}
