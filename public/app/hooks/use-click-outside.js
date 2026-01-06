/* global document:false,setTimeout:false,clearTimeout:false */
import { useEffect, useRef } from "react";

// Hook to detect clicks outside of a component
export const useClickOutside = (active, setActive, delay = 0) => {
  const ref = useRef(null);

  const handleClick = (event) => {
    if (active && ref.current && !ref.current.contains(event.target)) {
      setActive(false);
    }
  };

  useEffect(() => {
    if (active) {
      const timer = setTimeout(() => {
        document.addEventListener("click", handleClick);
      }, delay);

      return () => {
        clearTimeout(timer);
        document.removeEventListener("click", handleClick);
      };
    }

    return () => {
      document.removeEventListener("click", handleClick);
    };
  }, [ref, active, setActive]);

  return ref;
};
