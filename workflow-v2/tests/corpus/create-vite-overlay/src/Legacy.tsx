import { Component } from 'react'

type GreetingProps = { name: string; punctuation?: string }

// Render-only: becomes a function component.
export class Greeting extends Component<GreetingProps> {
  static defaultProps = { punctuation: '!' }

  render() {
    const { name, punctuation } = this.props
    return (
      <p>
        Hello, {name}
        {punctuation}
      </p>
    )
  }
}

type CounterState = { count: number }

// State and a lifecycle method: stays a class, flagged.
export class LegacyCounter extends Component<{ step: number }, CounterState> {
  state: CounterState = { count: 0 }

  componentDidMount() {
    console.log('legacy counter mounted')
  }

  render() {
    return (
      <button type="button" onClick={() => this.setState({ count: this.state.count + this.props.step })}>
        Legacy count is {this.state.count}
      </button>
    )
  }
}
