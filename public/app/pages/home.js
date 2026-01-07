import { Fragment } from "react";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { PersistentLink as Link } from "../components/persistent-link.js";
import { useSettings } from "../hooks/use-settings.js";
import { ShortDescription as ChatShortDescription } from "./chat.js";
import { FEATURES } from "../../config.js";

export const Home = () => {
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;

  return html`
    <${Page} name="Joyce">
      ${
        !isDeveloperMode &&
        html`
        <${Fragment}>
          <p>
            Joyce is a knowledge assistant that incorporates Nearform's blogs, case studies, and services pages into
            tools to find content ${FEATURES.chat.enabled ? "and generate text answers" : ""} using AI.
            Go ahead and try it out! ${" "}<i className="iconoir-sparks"></i>
          </p>
          <ul>
            <li id="posts"><${Link} to="/posts">Posts</${Link}>: Browse / filter all available content.</li>
            <li id="search"><${Link} to="/search">Search</${Link}>: Find / filter similar posts to a query.</li>
            ${
              FEATURES.chat.enabled &&
              html`
              <li id="chat"><${Link} to="/chat">Chat</${Link}>: Get answers from AI using our content.</li>
            `
            }
            <li id="settings"><${Link} to="/settings">Settings</${Link}>: Enable hidden developer features.</li>
          </ul>
        </${Fragment}>
        `
      }
      ${
        isDeveloperMode &&
        html`
        <${Fragment}>
          <h2 className="content-subhead">Introduction</h2>
          <p>
            Joyce is a knowledge assistant that introduces AI concepts using
            Nearform's web content as a data source for useful information and examples.
            To take a glance at all of the source data, please head over to
            the <${Link} to="/posts">posts</${Link}> page and see the downloadable JSON data.
          </p>
          <p>
            We scrape all blog and work/case study post data directly from our websites and first store
            as JSON on local disk and add embeddings using a small emebeddings
            model (currently <a href="https://huggingface.co/Xenova/gte-small"><code>gte-small</code></a>).
            Then we load the data into an <a href="https://docs.oramasearch.com/docs/orama-js">Orama</a> database,
            where we store basic metadata and embeddings for each post. (This allows us to perform similarity searches).
          </p>

          <h2 className="content-subhead">Similarity Search</h2>
          <p>
            The <${Link} to="/search">search</${Link}> page allows you to find similar posts based on a
            query. To facilitate this, we get embeddings for the query using the same model we used for
            the posts storage in the database. We then perform a similarity search
            (<a href="https://www.imaurer.com/which-vector-similarity-metric-should-i-use/">cosine distance</a>)
            in the database to find the top "n" most similar posts.
          </p>

          ${
            FEATURES.chat.enabled &&
            html`
              <${Fragment}>
                <h2 className="content-subhead">Chat</h2>
                <${ChatShortDescription} />
              </${Fragment}>
            `
          }
        </${Fragment}>
        `
      }
    </${Page}>
  `;
};
