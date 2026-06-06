/* global setTimeout:false */
import { useState } from "react";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { Form, Checkbox } from "../components/forms.js";
import { useSettings } from "../hooks/use-settings.js";
import { Alert } from "../components/alert.js";
import {
  getStatus as getCrashboxStatus,
  bootstrap as bootstrapCrashbox,
  shutdown as shutdownCrashbox,
  breadcrumb,
} from "../../local/data/telemetry.js";

// Duration to show success message (in milliseconds)
const SUCCESS_MESSAGE_DURATION = 3000;

export const Settings = () => {
  const [settings, updateSettings] = useSettings();
  const [showSuccess, setShowSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [pendingSettings, setPendingSettings] = useState(settings);
  // Reflects the actual booted state, not the pending toggle — `getStatus()` is null until
  // crashbox is bootstrapped (at app load, or live via handleSubmit below), and null again after
  // shutdown. Recomputed each render, so it flips as soon as Save bootstraps/tears down.
  const crashboxActive = getCrashboxStatus() !== null;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (hasChanges) {
      updateSettings(pendingSettings);
      // Apply the crash-detection toggle live (no reload): bootstrap on enable, tear down on
      // disable. `settings` still holds the previously-applied value here, so it's the diff base.
      if (
        pendingSettings.experimentalCrashbox &&
        !settings.experimentalCrashbox
      ) {
        bootstrapCrashbox();
        breadcrumb("app:boot");
      } else if (
        !pendingSettings.experimentalCrashbox &&
        settings.experimentalCrashbox
      ) {
        shutdownCrashbox();
      }
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
    <${Page} name="Settings" icon="iconoir-tools">
      <p>
        Configure application-wide settings and preferences.
        ${" "}<button
          type="button"
          aria-label=${
            pendingSettings.showExperimental
              ? "Hide experimental settings"
              : "Show experimental settings"
          }
          style=${{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            display: "inline-block",
            transition: "transform 0.2s",
            transform: pendingSettings.showExperimental
              ? "rotate(30deg)"
              : "none",
            fontSize: "inherit",
            color: "inherit",
          }}
          onClick=${() => {
            const newShowExperimental = !pendingSettings.showExperimental;
            const updatedPendingSettings = {
              ...pendingSettings,
              showExperimental: newShowExperimental,
            };
            setPendingSettings(updatedPendingSettings);
            updateSettings({
              ...settings,
              showExperimental: newShowExperimental,
            });
          }}
        ><i className="iconoir-flask"></i></button>
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

              <${Checkbox}
                id="display-model-stats"
                label="Display Model Stats"
                checked=${pendingSettings.displayModelStats}
                onChange=${handleSettingChange("displayModelStats")}
              >
                Show model token limits and info in the UI.
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

              <h4>Diagnostics</h4>

              <${Checkbox}
                id="experimental-crashbox"
                label="Crash Detection"
                checked=${pendingSettings.experimentalCrashbox}
                onChange=${handleSettingChange("experimentalCrashbox")}
              >
                Capture browser crashes, WebGPU device-loss events, and
                breadcrumbs for recovery on next load. Stores session state in
                localStorage.${" "}
                <span
                  className=${`status-badge ${crashboxActive ? "status-supported" : "status-unsupported"}`}
                >
                  ${crashboxActive ? "Active" : "Inactive"}
                </span>
              </${Checkbox}>
            `
          }
        </fieldset>
      </${Form}>
    </${Page}>
  `;
};
