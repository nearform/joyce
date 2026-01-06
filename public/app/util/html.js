/* global TextDecoder:false,document:false,window:false */
import React from "react";
import htm from "htm";

export const html = htm.bind(React.createElement);

export const getElements = (event) => {
  // Ignore array elements, grabbing only named properties.
  const propNames = Object.getOwnPropertyNames(
    event.currentTarget.elements,
  ).filter(([k]) => !/^[0-9]+$/.test(k.toString()));

  return Object.fromEntries(
    propNames.map((k) => {
      const v = event.currentTarget.elements[k];
      if (v.type === "number") {
        return [k, v.valueAsNumber];
      }

      return [k, v.value.trim()];
    }),
  );
};

export async function* streamResponse(response) {
  const decoder = new TextDecoder("UTF-8");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamJsonResponse(response) {
  let buffer = "";

  for await (const chunk of streamResponse(response)) {
    buffer += chunk;

    // Split by newlines and process complete lines
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        yield JSON.parse(line);
      }
    }
  }

  // Process any remaining data in buffer
  if (buffer.trim()) {
    yield JSON.parse(buffer);
  }
}

export const getQuerySetter = (id) => (query) => {
  const textarea = document.querySelector(`textarea[id="${id}"]`);
  if (textarea) {
    textarea.value = query;
  }
};

/**
 * Open formatted text in a new browser window inside a <pre> element.
 * @param {string} text - Pre-formatted text to display
 */
export const openTextInNewWindow = (text) => {
  const win = window.open("", "_blank");
  win.document.write("<html><body><pre></pre></body></html>");
  win.document.close();
  win.document.querySelector("pre").innerText = text;
};
