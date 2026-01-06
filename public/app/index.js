import { html } from "./util/html.js";
import { Layout } from "./components/layout.js";
import { ConfigProvider } from "./contexts/config.js";
import { LoadingProvider } from "../local/app/context/loading.js";

export const App = (props) => {
  const { config = {}, ...otherProps } = props;
  return html`
    <${ConfigProvider} config=${config}>
      <${LoadingProvider}>
        <${Layout} ...${otherProps} />
      </${LoadingProvider}>
    </${ConfigProvider}>
  `;
};
