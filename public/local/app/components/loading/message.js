import { html } from "../../../../app/util/html.js";
import { useLoading } from "../../context/loading.js";

/**
 * Component for displaying status messages based on loading state
 * @param {Object} props
 * @param {string} props.resourceId - The resource identifier
 * @param {string} props.type - Message type: "info" or "error"
 * @param {string} props.message - Custom message to display (optional)
 * @param {boolean} props.showWhenLoaded - Whether to show message when loaded (default: false)
 */
export const LoadingMessage = ({
  resourceId,
  type = "info",
  message = null,
  showWhenLoaded = false,
}) => {
  const { getStatus, getError } = useLoading();
  const status = getStatus(resourceId);
  const error = getError(resourceId);

  // Don't show if loaded and showWhenLoaded is false
  if (status === "loaded" && !showWhenLoaded) {
    return null;
  }

  // Don't show if no error and type is error
  if (type === "error" && status !== "error") {
    return null;
  }

  // Don't show if not loading and type is info and no custom message
  if (type === "info" && status !== "loading" && !message) {
    return null;
  }

  const typeClasses = {
    info: "alert-info",
    error: "alert-error",
  };

  const displayMessage =
    message ||
    (type === "error" && error
      ? error.message || error.toString()
      : type === "info" && status === "loading"
        ? "Loading..."
        : "");

  if (!displayMessage) {
    return null;
  }

  return html`
    <div className=${`alert ${typeClasses[type]}`}>${displayMessage}</div>
  `;
};
