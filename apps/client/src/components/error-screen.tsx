import { Component, ReactNode } from 'react'

// If the app crashes (a render error, a WebGL context it can't recover),
// show the site's 500 page (public/500.html) rather than a blank screen.
// It's framed whole, so there's one design for it; its buttons act on
// this window.
class ErrorScreen extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('The app crashed', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <iframe
        src="/500.html"
        title="Something went wrong"
        className="fixed inset-0 w-full h-full border-0"
      />
    )
  }
}

export default ErrorScreen
