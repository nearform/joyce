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
};

/**
 * Get settings from localStorage with defaults
 * @returns {Object} Settings object
 */
function getSettings() {
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
