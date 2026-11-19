import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Evita que um erro de render deixe o painel em tela branca. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("dashboard.render.error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel error" role="alert">
        <h2>O painel encontrou um erro</h2>
        <p>{this.state.error.message}</p>
        <button onClick={() => this.setState({ error: null })}>Tentar novamente</button>
      </div>
    );
  }
}
