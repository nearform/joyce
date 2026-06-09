/* global localStorage:false, console:false, window:false, CustomEvent:false */
import { useState, useEffect } from "react";

const STORAGE_KEY = "app_settings";
const SETTINGS_CHANGE_EVENT = "app-settings-change";

/**
 * Default settings values
 * @type {Object}
 */
const DEFAULT_SETTINGS = {
  isDeveloperMode: false,
  displayModelStats: false,
  // Remote-specific settings (included for compatibility, not shown in UI)
  displayAnalytics: false,
  featureOpenAIToolEnabled: false,
  showExperimental: false,
  // Experimental settings
  experimentalChat: false,
  experimentalChatConversations: false,
  // Reasoning models (Qwen3, DeepSeek-R1) emit a <think> block before the answer. Off = ask web-llm
  // to skip it (faster, cleaner answers); on = let the model reason and view it via the dev-mode
  // "thinking" icon. No effect on non-reasoning models.
  enableThinking: false,
  experimentalWebgpuEmbeddings: false,
  experimentalCrashbox: false,
  // Off (default) = one web-llm model in memory at a time (switching unloads the previous, which
  // stays cached on disk for a fast reload). On = keep multiple loaded (faster switching, more OOM risk).
  experimentalMultipleModels: false,
  // Optional manual memory-budget override in MB (0/unset = auto-detect from navigator.deviceMemory).
  // Escape hatch for big desktops where deviceMemory caps at 8 and under-reports true RAM.
  memoryBudgetMb: 0,
};

/**
 * Get settings from localStorage with defaults
 * @returns {Object} Settings object
 */
export function getSettings() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_SETTINGS;
    }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch (err) {
    console.error("Failed to load settings:", err);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save settings to localStorage and dispatch change event
 * @param {Object} settings Settings to save
 */
function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(
      new CustomEvent(SETTINGS_CHANGE_EVENT, { detail: settings }),
    );
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}

/**
 * Hook for managing application settings
 * @returns {[Object, Function]} Settings object and update function
 */
export function useSettings() {
  const [settings, setSettings] = useState(getSettings());

  useEffect(() => {
    // Handler for settings change events
    const handleSettingsChange = (event) => {
      setSettings(event.detail);
    };

    // Listen for settings changes
    window.addEventListener(SETTINGS_CHANGE_EVENT, handleSettingsChange);

    return () => {
      window.removeEventListener(SETTINGS_CHANGE_EVENT, handleSettingsChange);
    };
  }, []);

  // Update settings with new values
  const updateSettings = (newSettings) => {
    const updatedSettings = { ...settings, ...newSettings };
    saveSettings(updatedSettings);
  };

  return [settings, updateSettings];
}
