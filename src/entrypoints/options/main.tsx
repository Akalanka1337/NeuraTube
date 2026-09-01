import { render } from 'preact';
import { App } from './App';
import './options.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('options root element missing');
}

render(<App />, root);
