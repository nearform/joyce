import { useState } from "react";
import { getElements, html } from "../util/html.js";
import { Page } from "../components/page.js";
import { PostsTable } from "../components/posts-table.js";
import {
  Form,
  PostMinDate,
  PostTypeSelect,
  PostCategoryPrimarySelect,
  QueryField,
} from "../components/forms.js";
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
  const [searchData, setSearchData] = useState(null);
  const [posts, setPosts] = useState(null);
  const [selectedCategoryPrimary, setSelectedCategoryPrimary] = useState([]);
  const [selectedPostTypes, setSelectedPostTypes] = useState([]);
  const [isFetching, setIsFetching] = useState(false);
  const [err, setErr] = useState(null);
  const [analyticsDates, setAnalyticsDates] = useState({
    start: null,
    end: null,
  });
  const [minDate, setMinDate] = useState("");
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;

  const handleSubmit = async (event) => {
    event.preventDefault();
    const { query } = getElements(event);
    if (!query) {
      return;
    }

    setIsFetching(true);
    setSearchData(null);
    setPosts(null);
    setErr(null);

    const postType = selectedPostTypes.map(({ value }) => value);
    const categoryPrimary = selectedCategoryPrimary.map(({ value }) => value);

    try {
      const searchResults = await search({
        query,
        postType,
        minDate,
        categoryPrimary,
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

  return html`
    <${Page} name="Search">
      <p>
        Search (and filter) the most similar blog posts that match a query.
        ${" "}
        ${isDeveloperMode && searchData && html`<${JsonDataLink} data=${searchData} />`}
        <${DownloadPostsCsv} posts=${posts} />
      </p>
      ${!isDeveloperMode && html`<${SuggestedQueries} ...${{ suggestions }} />`}
      <${Form} ...${{ isFetching, handleSubmit, submitName: "Search" }}>
        <${QueryField} />
        <${PostTypeSelect}
          selected=${selectedPostTypes}
          setSelected=${setSelectedPostTypes}
        />
        <${PostCategoryPrimarySelect}
          selected=${selectedCategoryPrimary}
          setSelected=${setSelectedCategoryPrimary}
        />
        <${PostMinDate} value=${minDate} setValue=${setMinDate} />
      </${Form}>

      ${err && html`<${Alert} type="error" err=${err}>${err.toString()}</${Alert}>`}
      ${posts?.length > 0 && html`<${PostsTable} posts=${posts} analyticsDates=${analyticsDates} />`}
      ${searchData && posts?.length === 0 && html`<p className="status">No results.</p>`}
    </${Page}>
  `;
};
