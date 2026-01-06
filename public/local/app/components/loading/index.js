export { LoadingButton } from "./button.js";
export { LoadingMessage } from "./message.js";
import { RESOURCES } from "../../../data/loading.js";

export const LOADING = Object.fromEntries(
  Object.entries(RESOURCES).map(([key, value]) => [key, value.id]),
);
