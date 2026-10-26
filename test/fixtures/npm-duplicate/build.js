// The fixture's "build": proves the installed dependency actually loads and works.
const odd = require("is-odd");
if (typeof odd !== "function" || odd(3) !== true || odd(4) !== false) {
  console.error("is-odd is broken");
  process.exit(1);
}
console.log("build ok");
