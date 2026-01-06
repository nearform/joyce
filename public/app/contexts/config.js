import { createContext, useContext } from "react";
import { html } from "../util/html.js";

// Create the context with a default value
const ConfigContext = createContext({});

// Provider component that will wrap the app
export const ConfigProvider = ({ children, config }) => {
  return html`
    <${ConfigContext.Provider} value=${config}>
      ${children}
    </${ConfigContext.Provider}>
  `;
};

// Hook to use the config
export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (Object.keys(context).length === 0) {
    throw new Error(
      "useConfig must be used within a ConfigProvider with a config value.",
    );
  }
  return context;
};
