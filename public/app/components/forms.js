/* global window:false */
import Select from "react-select";
import { html } from "../util/html.js";
import { CATEGORIES_LIST } from "./category.js";
import { VERTICALS_LIST } from "./vertical.js";
import {
  ALL_CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  ALL_PROVIDERS,
  getModelCfg,
  getSimpleModelOptions,
  DEFAULT_DATASTORE,
  DEFAULT_API,
  DEFAULT_TEMPERATURE,
} from "../../config.js";
import { useSettings } from "../hooks/use-settings.js";
import { useState, createContext, useContext } from "react";
import { useLoading } from "../../local/app/context/loading.js";
import { useClickOutside } from "../hooks/use-click-outside.js";
import { formatInt } from "../../shared-util.js";

const CATEGORY_OPTIONS = CATEGORIES_LIST.map((category) => ({
  label: category,
  value: category,
}));

const VERTICAL_OPTIONS = VERTICALS_LIST.map((vertical) => ({
  label: vertical,
  value: vertical,
}));

const POST_TYPE_OPTIONS = [
  { label: "Services", value: "service" },
  { label: "Work", value: "work" },
  { label: "Blogs", value: "blog" },
];

export const IS_LOCALHOST =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "[::1]";

// ================================================================================================
// Helpers
// ================================================================================================
const getTargetValue = (eventOrString) => {
  if (typeof eventOrString === "object" && eventOrString?.target) {
    return eventOrString.target.value;
  }

  return eventOrString;
};

// ================================================================================================
// Chat Form Context API
// ================================================================================================
export const ChatFormContext = createContext({ onDropdownToggle: () => {} });

export const ChatFormProvider = ({ onDropdownToggle = () => {}, children }) => {
  return html`<${ChatFormContext.Provider} value=${{ onDropdownToggle }}>
    ${children}
  <//>`;
};

export const useChatForm = () => useContext(ChatFormContext);

// ================================================================================================
// Abstractions
// ================================================================================================
// Generic dropdown wrapper for form controls
export const DropdownWrapper = ({
  icon = "iconoir-chevron-down",
  iconTitle = "Show options",
  isChanged = false,
  hidden = false,
  disabled = false,
  className,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const { onDropdownToggle } = useChatForm();
  const setOpenState = (isOpen) => {
    setIsOpen(isOpen);
    onDropdownToggle(isOpen);
  };
  const dropdownRef = useClickOutside(isOpen, setOpenState);

  const toggleOpen = () => {
    if (disabled) return;
    setOpenState(!isOpen);
  };

  const iconClasses = [
    icon,
    "form-dropdown-icon",
    isChanged ? "form-dropdown-icon-changed" : "",
    disabled ? "form-dropdown-icon-disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return html`
    <div
      className=${`form-dropdown ${className ?? ""}`}
      hidden=${hidden}
      ref=${dropdownRef}
    >
      <i className=${iconClasses} onClick=${toggleOpen} title=${iconTitle}></i>
      ${isOpen && !disabled
        ? html`<div className="form-dropdown-content" onClick=${toggleOpen}>
            <div
              className="form-dropdown-content-inner"
              onClick=${(e) => e.stopPropagation()}
            >
              ${children}
            </div>
          </div>`
        : ""}
    </div>
  `;
};

// ================================================================================================
// Components
// ================================================================================================
const Submit = ({ submitName = "Submit", isFetching }) => html`
  <button
    type="submit"
    className="pure-button pure-button-primary ${(isFetching &&
      "pure-button-disabled") ||
    ""}"
  >
    ${submitName.startsWith("iconoir-")
      ? html`<i className=${submitName}></i>`
      : submitName}
  </button>
`;

/** Submit button with arrow-up icon. */
const AskButton = ({ isFetching, title = "Ask" }) => html`
  <button
    type="submit"
    title=${title}
    disabled=${isFetching}
    className="pure-button pure-button-primary chat-submit-icon-btn ${isFetching
      ? "pure-button-disabled"
      : ""}"
  >
    <i className="iconoir-send"></i>
  </button>
`;

/** Reset button to clear conversation and start fresh. */
const ResetButton = ({ isFetching, onReset }) => {
  const handleReset = (e) => {
    e.preventDefault();
    onReset();
  };
  return html`
    <button
      type="button"
      title="Clear conversation and start fresh"
      className="pure-button chat-submit-icon-btn ${isFetching
        ? "pure-button-disabled"
        : ""}"
      onClick=${handleReset}
      disabled=${isFetching}
    >
      <i className="iconoir-refresh-double"></i>
    </button>
  `;
};

export const ChatSubmitButton = ({
  isFetching,
  hasCompletions = false,
  conversationsEnabled = false,
  onReset,
}) => {
  const showButtonGroup = hasCompletions && conversationsEnabled;
  if (!showButtonGroup) {
    return html`<${AskButton} isFetching=${isFetching} />`;
  }

  return html`
    <div className="pure-button-group" role="group">
      <${AskButton} isFetching=${isFetching} title="Continue conversation" />
      <${ResetButton} isFetching=${isFetching} onReset=${onReset} />
    </div>
  `;
};

const handleQueryKeyDown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const value = e.target.value.trim();
    if (value) e.target.form.requestSubmit();
  }
};

export const QueryField = ({ placeholder = "Ask anything" }) => html`
  <fieldset>
    <textarea
      id="query"
      placeholder=${placeholder}
      className="pure-input-1"
      rows="3"
      onKeyDown=${handleQueryKeyDown}
    ></textarea>
  </fieldset>
`;

export const PostTypeSelect = ({
  selected,
  setSelected,
  menuPlacement = "auto",
}) => html`
  <label htmlFor="postType" style=${{ whiteSpace: "nowrap" }}>
    <div className="form-multi-select">
      <${Select}
        id="postType"
        placeholder="Types..."
        isMulti=${true}
        menuPlacement=${menuPlacement}
        options=${POST_TYPE_OPTIONS}
        value=${selected}
        onChange=${setSelected}
      />
    </div>
  </label>
`;

export const PostTypeSelectDropdown = ({
  hidden,
  selected = [],
  setSelected,
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleTypeChange = (selectedOptions) => {
    setSelected(selectedOptions);
    setHasChanged(selectedOptions.length > 0);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-multiple-pages"
      iconTitle=${disabled ? "Post Types (locked)" : "Post Types"}
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${PostTypeSelect}
        selected=${selected}
        setSelected=${handleTypeChange}
        menuPlacement="top"
      />
    </${DropdownWrapper}>
  `;
};

export const PostCategoryPrimarySelect = ({
  selected,
  setSelected,
  menuPlacement = "auto",
}) => html`
  <label htmlFor="categoryPrimary" style=${{ whiteSpace: "nowrap" }}>
    <div className="form-multi-select">
      <${Select}
        id="categoryPrimary"
        placeholder="Categories..."
        isMulti=${true}
        menuPlacement=${menuPlacement}
        options=${CATEGORY_OPTIONS}
        value=${selected}
        onChange=${setSelected}
      />
    </div>
  </label>
`;

export const PostCategoryPrimarySelectDropdown = ({
  hidden,
  selected = [],
  setSelected,
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleCategoryChange = (selectedOptions) => {
    setSelected(selectedOptions);
    setHasChanged(selectedOptions.length > 0);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-list-select"
      iconTitle=${disabled ? "Categories (locked)" : "Primary Categories"}
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${PostCategoryPrimarySelect}
        selected=${selected}
        setSelected=${handleCategoryChange}
        menuPlacement="top"
      />
    </${DropdownWrapper}>
  `;
};

export const PostVerticalPrimarySelect = ({
  selected,
  setSelected,
  menuPlacement = "auto",
}) => html`
  <label htmlFor="verticalPrimary" style=${{ whiteSpace: "nowrap" }}>
    <div className="form-multi-select">
      <${Select}
        id="verticalPrimary"
        placeholder="Verticals..."
        isMulti=${true}
        menuPlacement=${menuPlacement}
        options=${VERTICAL_OPTIONS}
        value=${selected}
        onChange=${setSelected}
      />
    </div>
  </label>
`;

export const PostVerticalPrimarySelectDropdown = ({
  hidden,
  selected = [],
  setSelected,
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleVerticalChange = (selectedOptions) => {
    setSelected(selectedOptions);
    setHasChanged(selectedOptions.length > 0);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-building"
      iconTitle=${disabled ? "Verticals (locked)" : "Industry Verticals"}
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${PostVerticalPrimarySelect}
        selected=${selected}
        setSelected=${handleVerticalChange}
        menuPlacement="top"
      />
    </${DropdownWrapper}>
  `;
};

// Note: Caller handles event.target.checked.
export const Checkbox = ({
  id,
  label,
  checked,
  onChange,
  title,
  children,
}) => html`
  <label className="pure-checkbox" ...${{ title }}>
    <input type="checkbox" id=${id} checked=${checked} onChange=${onChange} />
    <strong>${label}</strong>
    ${children ? html`: ${children}` : ""}
  </label>
`;

// Model select helpers.
const modelOptionsAreEqual = (a, b) =>
  a.provider === b.provider && a.model === b.model;

// react-select can't handle objects well, so translate under the hood.
const MODEL_OBJ_SEP = "::";
const modelObjToOption = ({ provider, model }) =>
  `${provider}${MODEL_OBJ_SEP}${model}`;
const optionToModelObj = (option) => {
  const [provider, model] = option.split(MODEL_OBJ_SEP);
  return { provider, model };
};

// Status icon configuration for model loading states (using solid/filled icons)
const MODEL_STATUS_CONFIG = {
  not_loaded: {
    icon: "iconoir-circle",
    cls: "loading-status-not-loaded",
    title: "Not loaded",
  },
  loading: {
    icon: "iconoir-refresh-circle-solid",
    cls: "loading-status-loading",
    title: "Loading...",
  },
  loaded: {
    icon: "iconoir-check-circle-solid",
    cls: "loading-status-loaded",
    title: "Loaded",
  },
  error: {
    icon: "iconoir-warning-circle-solid",
    cls: "loading-status-error",
    title: "Error",
  },
};

// Simple status icon for model select options (non-interactive)
const ModelStatusIcon = ({ status }) => {
  const config = MODEL_STATUS_CONFIG[status] || MODEL_STATUS_CONFIG.not_loaded;
  return html`
    <span className=${`model-status-icon ${config.cls}`} title=${config.title}>
      <i className=${config.icon}></i>
    </span>
  `;
};

const modelStats = ({ vramMb, maxTokens }) =>
  `Max Input: ${(maxTokens ?? 0).toLocaleString("en-US")} tokens, VRAM: ${(vramMb ?? 0).toLocaleString("en-US")} MB`;

const isNullish = (value) => value == null;

export const ModelChatSelect = ({
  selected,
  setSelected,
  defaultValue = DEFAULT_CHAT_MODEL,
  providers,
  menuPlacement = "auto",
}) => {
  const [settings] = useSettings();
  const { isDeveloperMode, displayModelStats } = settings;
  const { getStatus } = useLoading();

  const getLabel = (label, { provider, model }) => {
    if (!displayModelStats) {
      return label;
    }

    const { quantization, vramMb, maxTokens } = getModelCfg({
      provider,
      model,
    });
    const vramString = !isNullish(vramMb) ? `M: ${formatInt(vramMb)} MB` : "";
    const maxTokensString = !isNullish(maxTokens)
      ? `T: ${formatInt(maxTokens)}`
      : "";
    const quantizationString = !isNullish(quantization)
      ? `Q: ${quantization}`
      : "";
    const statsString = [maxTokensString, vramString, quantizationString]
      .filter(Boolean)
      .join(", ");
    return `${label} ${statsString ? `(${statsString})` : ""}`;
  };

  let options;
  if (isDeveloperMode) {
    options = ALL_CHAT_MODELS.filter(({ provider }) =>
      providers.has(provider),
    ).map(({ provider, models }) => ({
      label: ALL_PROVIDERS[provider],
      options: models.map(({ model }) => {
        const cfg = getModelCfg({ provider, model });
        return {
          id: `${provider}-${model}`,
          title: modelStats(cfg),
          label: getLabel(cfg.modelShortName, { provider, model }),
          value: modelObjToOption({ provider, model }),
          model, // Store model ID for status lookup
        };
      }),
    }));
  } else {
    const provider = DEFAULT_CHAT_MODEL.provider;
    options = getSimpleModelOptions(provider).map(({ label, model }) => ({
      id: `${provider}-${model}`,
      label: getLabel(label, { provider, model }),
      value: modelObjToOption({ provider, model }),
      model, // Store model ID for status lookup
    }));
  }

  // Manually set the selected state. (From doing object values).
  const isOptionSelected = ({ value }) => value === modelObjToOption(selected);
  const divClass = `form-multi-select-${isDeveloperMode ? "wide" : "medium"}`;

  // Custom format for options showing status icon
  const formatOptionLabel = (option) => {
    const modelId = option.model;
    const status = modelId ? getStatus(`llm_${modelId}`) : "not_loaded";
    return html`
      <span className="model-option-label">
        <${ModelStatusIcon} status=${status} />
        <span>${option.label}</span>
      </span>
    `;
  };

  return html`
    <label htmlFor="model" style=${{ whiteSpace: "nowrap" }}>
      <div className=${`form-multi-select ${divClass}`}>
        <${Select}
          id="model"
          title="LLM Model"
          placeholder="Model..."
          defaultValue=${modelObjToOption(defaultValue)}
          menuPlacement=${menuPlacement}
          options=${options}
          isOptionSelected=${isOptionSelected}
          value=${modelObjToOption(selected)}
          onChange=${({ value }) => setSelected(optionToModelObj(value))}
          formatOptionLabel=${formatOptionLabel}
        />
      </div>
    </label>
  `;
};

export const ModelChatSelectDropdown = ({
  hidden,
  selected,
  setSelected,
  defaultValue = DEFAULT_CHAT_MODEL,
  providers,
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleModelChange = (modelObj) => {
    setSelected(modelObj);
    setHasChanged(!modelOptionsAreEqual(modelObj, defaultValue));
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-sparks"
      iconTitle=${disabled ? "Model (locked)" : "LLM Model (Chat)"}
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${ModelChatSelect}
        defaultValue=${defaultValue}
        selected=${selected}
        setSelected=${handleModelChange}
        providers=${providers}
      />
    </${DropdownWrapper}>
  `;
};

// TODO(LOCAL): Remove (or just don't use) datastore option (and input and dropdown input)?
// Datastore select helpers
const DATASTORE_OPTIONS = [
  {
    label: "Postgres",
    value: "postgresql",
    title: "PostgreSQL with pgvector on Neon", // TODO: Are titles used?
  },
  { label: "OpenAI Search", value: "openai", title: "OpenAI Vector Store" },
  {
    label: "OpenAI Tool",
    value: "openai-tool",
    title: "OpenAI File Search Tool",
  },
];

export const DatastoreSelect = ({
  hidden,
  selected,
  setSelected,
  defaultValue = DEFAULT_DATASTORE,
  menuPlacement = "auto",
  includeOpenAITool = true,
}) => {
  const [settings] = useSettings();

  // Create options array with conditional openai-tool option
  const options =
    includeOpenAITool && settings.featureOpenAIToolEnabled
      ? DATASTORE_OPTIONS
      : DATASTORE_OPTIONS.filter(({ value }) => value !== "openai-tool");

  return html`
    <label
      title="Select content datastore"
      hidden=${hidden}
      style=${{ whiteSpace: "nowrap" }}
    >
      <div className="form-multi-select">
        <${Select}
          id="datastore"
          placeholder="Datastore..."
          defaultValue=${defaultValue}
          menuPlacement=${menuPlacement}
          options=${options}
          isOptionSelected=${({ value }) => value === selected}
          value=${selected}
          onChange=${({ value }) => setSelected(value)}
        />
      </div>
    </label>
  `;
};

export const DatastoreSelectDropdown = ({
  hidden,
  selected,
  setSelected,
  defaultValue = DEFAULT_DATASTORE,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleChange = (value) => {
    setSelected(value);
    setHasChanged(value !== defaultValue);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-database"
      iconTitle="Datastore"
      isChanged=${hasChanged}
      hidden=${hidden}
    >
      <${DatastoreSelect}
        hidden=${hidden}
        defaultValue=${defaultValue}
        selected=${selected}
        setSelected=${handleChange}
        menuPlacement="top"
      />
    </${DropdownWrapper}>
  `;
};

// API select helpers
const API_OPTIONS = [
  {
    label: "Chat Completions",
    value: "chat",
    title: "Chat Completions",
  },
  {
    label: "Responses",
    value: "responses",
    title: "API Responses",
  },
];

export const ApiSelect = ({
  hidden,
  selected,
  setSelected,
  defaultValue = DEFAULT_API,
  menuPlacement = "auto",
}) => {
  return html`
    <label
      title="Select API type"
      hidden=${hidden}
      style=${{ whiteSpace: "nowrap" }}
    >
      <div className="form-multi-select form-multi-select-medium">
        <${Select}
          id="api"
          placeholder="API..."
          defaultValue=${defaultValue}
          menuPlacement=${menuPlacement}
          options=${API_OPTIONS}
          isOptionSelected=${({ value }) => value === selected}
          value=${selected}
          onChange=${({ value }) => setSelected(value)}
        />
      </div>
    </label>
  `;
};

export const ApiSelectDropdown = ({
  hidden,
  selected,
  setSelected,
  defaultValue = DEFAULT_API,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleChange = (value) => {
    setSelected(value);
    setHasChanged(value !== defaultValue);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-cloud-sync"
      iconTitle="API"
      isChanged=${hasChanged}
      hidden=${hidden}
    >
      <${ApiSelect}
        hidden=${hidden}
        defaultValue=${defaultValue}
        selected=${selected}
        setSelected=${handleChange}
        menuPlacement="top"
      />
    </${DropdownWrapper}>
  `;
};

const TEMPERATURE_TITLE =
  "Temperature. From 0 (more deterministic) to 1 (more random)";

// Raw temperature input (no dropdown logic)
export const Temperature = ({
  value,
  defaultValue = DEFAULT_TEMPERATURE,
  onChange,
  id = "temperature",
  min = 0,
  max = 1,
  step = 0.1,
  hidden = false,
}) => {
  return html`
    <label
      title=${TEMPERATURE_TITLE}
      className="form-dropdown-input-box"
      style=${{ whiteSpace: "nowrap" }}
      hidden=${hidden}
    >
      Temperature:${" "}<input
        id=${id}
        type="number"
        min=${min}
        max=${max}
        step=${step}
        defaultValue=${value || defaultValue}
        onChange=${(e) => onChange(parseFloat(getTargetValue(e)))}
      />
    </label>
  `;
};

// Wrapped temperature input with dropdown (for current usage)
export const TemperatureDropdown = ({
  hidden,
  value = DEFAULT_TEMPERATURE,
  onChange = () => {},
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleTemperatureChange = (value) => {
    setHasChanged(value !== DEFAULT_TEMPERATURE);
    onChange(value);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-temperature-high"
      iconTitle=${disabled ? "Temperature (locked)" : TEMPERATURE_TITLE}
      className="form-dropdown-hideable"
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${Temperature}
        value=${value}
        onChange=${handleTemperatureChange}
      />
    </${DropdownWrapper}>
  `;
};

// Context size control (max tokens for RAG context)
const CONTEXT_SIZE_TITLE =
  "Max context tokens for RAG (higher = more context, more VRAM)";

const ContextSize = ({
  value,
  defaultValue,
  max,
  onChange,
  id = "contextSize",
}) => {
  return html`
    <label
      title=${CONTEXT_SIZE_TITLE}
      className="form-dropdown-input-box"
      style=${{ whiteSpace: "nowrap" }}
    >
      Context:${" "}<input
        id=${id}
        type="number"
        min=${1024}
        max=${max}
        step=${1024}
        defaultValue=${value || defaultValue}
        onChange=${(e) => onChange(parseInt(getTargetValue(e), 10))}
      />${" "}/ ${max.toLocaleString()}
    </label>
  `;
};

export const ContextSizeDropdown = ({
  hidden,
  value,
  defaultValue,
  max,
  onChange = () => {},
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleChange = (val) => {
    setHasChanged(val !== defaultValue);
    onChange(val);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-scale-frame-enlarge"
      iconTitle=${disabled ? "Context size (locked)" : CONTEXT_SIZE_TITLE}
      className="form-dropdown-hideable"
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${ContextSize}
        value=${value}
        defaultValue=${defaultValue}
        max=${max}
        onChange=${handleChange}
      />
    </${DropdownWrapper}>
  `;
};

const MIN_DATE_TITLE = "Filter to posts published on/before this date";

export const PostMinDate = ({ value, setValue, className }) => html`
  <label
    title=${MIN_DATE_TITLE}
    className=${className}
    style=${{ whiteSpace: "nowrap" }}
  >
    After:${" "}
    <input
      id="minDate"
      type="date"
      value=${value}
      onChange=${(e) => setValue(getTargetValue(e))}
    />
  </label>
`;

// Wrapped min date input with dropdown
export const PostMinDateDropdown = ({
  hidden,
  value = "",
  onChange = () => {},
  disabled = false,
}) => {
  const [hasChanged, setHasChanged] = useState(false);

  const handleChange = (value) => {
    setHasChanged(!!value);
    onChange(value);
  };

  return html`
    <${DropdownWrapper}
      icon="iconoir-calendar"
      iconTitle=${disabled ? "Date (locked)" : MIN_DATE_TITLE}
      isChanged=${hasChanged}
      hidden=${hidden}
      disabled=${disabled}
    >
      <${PostMinDate} className="form-dropdown-input-box" value=${value} setValue=${handleChange}/>
    </${DropdownWrapper}>
  `;
};

// ================================================================================================
// Forms
// ================================================================================================
export const Form = ({
  handleSubmit,
  submitName = "Submit",
  isFetching,
  children,
}) => html`
  <form className="pure-form" onSubmit=${handleSubmit}>
    ${children}
    <${Submit} ...${{ submitName, isFetching }} />
  </form>
`;

export const ChatInputForm = ({
  onSubmit,
  onReset,
  isFetching,
  hasCompletions = false,
  conversationsEnabled = false,
  children,
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const onFormSubmit = (event) => {
    event.preventDefault();
    onSubmit(event);
  };

  return html`
    <${ChatFormProvider} onDropdownToggle=${setIsDropdownOpen}>
      <div className="chat-input-container">
        <div className="chat-input-container-inner">
          <form className="pure-form" onSubmit=${onFormSubmit}>
            ${children}
            <${ChatSubmitButton}
              isFetching=${isFetching}
              hasCompletions=${hasCompletions}
              conversationsEnabled=${conversationsEnabled}
              onReset=${onReset}
            />
          </form>
          <div className=${isDropdownOpen ? "chat-input-overlay-mask" : ""}></div>
        </div>
      </div>
    </${ChatFormProvider}>
  `;
};
