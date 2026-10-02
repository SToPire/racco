import { Component, type ReactNode } from "react";

/** Raw provider details are optional: their rendering must not take down chat. */
export class InspectorErrorBoundary extends Component<
  { children: ReactNode; onClose(): void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <aside className="tool-inspector" aria-label="工具详情">
        <div role="alert">
          <h2>无法显示工具详情</h2>
          <p>对话仍可阅读。请关闭详情后继续。</p>
        </div>
        <button type="button" onClick={this.props.onClose}>
          关闭工具详情
        </button>
      </aside>
    );
  }
}
