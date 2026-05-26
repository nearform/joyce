import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { getElements, html } from "../util/html.js";
import { Page } from "../components/page.js";
import { PostsTable } from "../components/posts-table.js";
import {
  Form,
  PostMinDate,
  PostTypeSelect,
  PostCategoryPrimarySelect,
  PostVerticalPrimarySelect,
  QueryField,
  POST_TYPE_OPTIONS,
  CATEGORY_OPTIONS,
  VERTICAL_OPTIONS,
} from "../components/forms.js";
import {
  parseMulti,
  parseStringParam,
  buildParams,
  multiToValues,
} from "../util/url-params.js";
import {
  DownloadPostsCsv,
  JsonDataLink,
} from "../components/posts-download.js";
import { useSettings } from "../hooks/use-settings.js";
import { Alert } from "../components/alert.js";
import { SuggestedQueries } from "../components/suggested-queries.js";
import { searchResultsToPosts } from "../data/util.js";
import { search } from "../data/index.js";

const suggestions = [
  "React native, mobile application development",
  "Financial services, banking, fintech",
  "Retail, e-commerce, commerce, shopping, checkout, cart, payment",
];

export const Search = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchData, setSearchData] = useState(null);
  const [posts, setPosts] = useState(null);
  const [selectedCategoryPrimary, setSelectedCategoryPrimary] = useState(() =>
    parseMulti(searchParams, "categoryPrimary", CATEGORY_OPTIONS),
  );
  const [selectedVerticalPrimary, setSelectedVerticalPrimary] = useState(() =>
    parseMulti(searchParams, "verticalPrimary", VERTICAL_OPTIONS),
  );
  const [selectedPostTypes, setSelectedPostTypes] = useState(() =>
    parseMulti(searchParams, "postType", POST_TYPE_OPTIONS),
  );
  const [isFetching, setIsFetching] = useState(false);
  const [err, setErr] = useState(null);
  const [analyticsDates, setAnalyticsDates] = useState({
    start: null,
    end: null,
  });
  const [minDate, setMinDate] = useState(() =>
    parseStringParam(searchParams, "minDate", ""),
  );
  const initialQuery = parseStringParam(searchParams, "query", "");
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;

  const runSearch = async (query) => {
    if (!query) {
      return;
    }

    const postType = multiToValues(selectedPostTypes);
    const categoryPrimary = multiToValues(selectedCategoryPrimary);
    const verticalPrimary = multiToValues(selectedVerticalPrimary);

    setSearchParams(
      buildParams({
        query,
        postType,
        categoryPrimary,
        verticalPrimary,
        minDate,
      }),
      { replace: true },
    );

    setIsFetching(true);
    setSearchData(null);
    setPosts(null);
    setErr(null);

    try {
      const searchResults = await search({
        query,
        postType,
        minDate,
        categoryPrimary,
        verticalPrimary,
        withContent: true,
      });
      const { posts, chunks, metadata } = searchResults;
      setSearchData(searchResults);
      const postsArray = searchResultsToPosts({ posts, chunks });
      setPosts(postsArray);
      setAnalyticsDates(metadata?.analytics?.dates);
    } catch (respErr) {
      setErr(respErr);
    } finally {
      setIsFetching(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const { query } = getElements(event);
    await runSearch(query);
  };

  useEffect(() => {
    if (initialQuery) {
      runSearch(initialQuery);
    }
  }, []);

  return html`
    <${Page} name="Search" icon="iconoir-doc-magnifying-glass-in">
      <p>
        Search (and filter) the most similar blog posts that match a query.
        ${" "}
        ${isDeveloperMode && searchData && html`<${JsonDataLink} data=${searchData} />`}
        <${DownloadPostsCsv} posts=${posts} />
      </p>
      ${!isDeveloperMode && html`<${SuggestedQueries} ...${{ suggestions }} />`}
      <${Form} ...${{ isFetching, handleSubmit, submitName: "Search" }}>
        <${QueryField} defaultValue=${initialQuery} />
        <${PostTypeSelect}
          selected=${selectedPostTypes}
          setSelected=${setSelectedPostTypes}
        />
        <${PostCategoryPrimarySelect}
          selected=${selectedCategoryPrimary}
          setSelected=${setSelectedCategoryPrimary}
        />
        <${PostVerticalPrimarySelect}
          selected=${selectedVerticalPrimary}
          setSelected=${setSelectedVerticalPrimary}
        />
        <${PostMinDate} value=${minDate} setValue=${setMinDate} />
      </${Form}>

      ${err && html`<${Alert} type="error" err=${err}>${err.toString()}</${Alert}>`}
      ${posts?.length > 0 && html`<${PostsTable} posts=${posts} analyticsDates=${analyticsDates} />`}
      ${searchData && posts?.length === 0 && html`<p className="status">No results.</p>`}
    </${Page}>
  `;
};
