/* global setTimeout:false */
import { useState } from "react";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { Form, Checkbox } from "../components/forms.js";
import { useSettings } from "../hooks/use-settings.js";
import { Alert } from "../components/alert.js";

// Duration to show success message (in milliseconds)
const SUCCESS_MESSAGE_DURATION = 3000;

export const Settings = () => {
  const [settings, updateSettings] = useSettings();
  const [showSuccess, setShowSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [pendingSettings, setPendingSettings] = useState(settings);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (hasChanges) {
      updateSettings(pendingSettings);
      setShowSuccess(true);
      setHasChanges(false);
      // Hide success message after specified duration
      setTimeout(() => setShowSuccess(false), SUCCESS_MESSAGE_DURATION);
    }
  };

  const handleSettingChange = (settingKey) => (event) => {
    const newSettings = {
      ...pendingSettings,
      [settingKey]: event.target.checked,
    };
    setPendingSettings(newSettings);
    setHasChanges(JSON.stringify(newSettings) !== JSON.stringify(settings));
  };

  return html`
    <${Page} name="Settings">
      <p>
        Configure application-wide settings and preferences.
        ${" "}<i
          className="iconoir-flask"
          style=${{
            cursor: "pointer",
            display: "inline-block",
            transition: "transform 0.2s",
            transform: pendingSettings.showExperimental
              ? "rotate(30deg)"
              : "none",
          }}
          onClick=${() => {
            const newSettings = {
              ...pendingSettings,
              showExperimental: !pendingSettings.showExperimental,
            };
            setPendingSettings(newSettings);
            updateSettings(newSettings);
          }}
        />
      </p>

      ${showSuccess && html`<${Alert} type="success">Settings saved successfully!</${Alert}>`}

      <${Form} handleSubmit=${handleSubmit} submitName="Save Settings" isFetching=${!hasChanges}>
        <fieldset>
          <legend>Modes</legend>

          <${Checkbox}
            id="developer-mode"
            label="Developer Mode"
            checked=${pendingSettings.isDeveloperMode}
            onChange=${handleSettingChange("isDeveloperMode")}
          >
            Show full developer options and features (choice of models,
            temperature, etc.).
          </${Checkbox}>

          <legend>Information</legend>

          <${Checkbox}
            id="display-model-stats"
            label="Display Model Stats"
            checked=${pendingSettings.displayModelStats}
            onChange=${handleSettingChange("displayModelStats")}
          >
            Show model token limits and info in the UI.
          </${Checkbox}>

          ${
            pendingSettings.showExperimental &&
            html`
              <legend>Experimental</legend>

              <h4>Chat</h4>

              <${Checkbox}
                id="experimental-chat"
                label="Enable Chat"
                checked=${pendingSettings.experimentalChat}
                onChange=${handleSettingChange("experimentalChat")}
              >
                Enable the Chat page for AI-generated answers using RAG.
              </${Checkbox}>

              <${Checkbox}
                id="experimental-chat-conversations"
                label="Enable Conversations"
                checked=${pendingSettings.experimentalChatConversations}
                onChange=${handleSettingChange("experimentalChatConversations")}
              >
                Enable multi-turn conversations in Chat.
              </${Checkbox}>

              <h4>Embeddings</h4>

              <${Checkbox}
                id="experimental-webgpu-embeddings"
                label="WebGPU Embeddings"
                checked=${pendingSettings.experimentalWebgpuEmbeddings}
                onChange=${handleSettingChange("experimentalWebgpuEmbeddings")}
              >
                Use WebGPU for embeddings extraction when available.
              </${Checkbox}>
            `
          }
        </fieldset>
      </${Form}>
    </${Page}>
  `;
};
