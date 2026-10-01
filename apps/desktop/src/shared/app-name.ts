/**
 * The name the app goes by on screen: the window title, and the title row in the
 * sidebar. The packages, the CLI (`vault`) and the MCP server keep their own
 * names; this is only what a person sees.
 *
 * renderer/index.html has to spell it out because an HTML file cannot import a
 * constant, and the page <title> wins over BrowserWindow's `title` once the page
 * loads. test/app-name.test.ts holds the two together.
 */
export const APP_NAME = "ToDo Vault";
