// Keep the browser reader and the server-side note pipeline on one canonical
// normalizer. The reader previously carried a smaller copy of this module,
// which meant fixes for tables, code blocks and malformed imported Markdown
// never reached the UI.
export {
  normalizeLooseCodeBlocks,
  normalizeReadingMarkdown,
} from "../../src/markdown";
