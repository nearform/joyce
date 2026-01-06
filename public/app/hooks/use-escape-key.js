/* global document:false */
import { useEffect } from "react";

// Hook to handle escape key press
export const useEscapeKey = (active, onEscape) => {
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape" && active) {
        onEscape();
      }
    };

    if (active) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [active, onEscape]);
};
