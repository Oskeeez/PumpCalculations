import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown above the error message. */
  title: string;
}

/** Keeps a failure in one page (for example WebGL) from blanking the whole app. */
export class ErrorBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="banner error">
          {this.props.title}: {this.state.error.message}
          <button onClick={() => this.setState({ error: undefined })} style={{ marginLeft: 12 }}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
