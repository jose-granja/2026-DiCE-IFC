/**
 * ESLint rule: no user payload may reach a network call.
 *
 * This is the mechanical half of AGENTS.md §1. It cannot prove the privacy
 * property — a determined author can always launder bytes through enough
 * indirection — but it catches the mistake that would actually happen: someone
 * reads a File, gets an ArrayBuffer, and posts it.
 *
 * Flagged when passed to `fetch`, `axios.*`, `XMLHttpRequest#send`,
 * `navigator.sendBeacon` or `WebSocket#send`:
 *
 *   - `new FormData()` / `new Blob()` / `new File()` written inline
 *   - an identifier bound in this file to `await <expr>.arrayBuffer()`,
 *     `.bytes()`, `.stream()`, `.text()` on something, or to a
 *     `new FormData/Blob/File`
 *   - a `File` / `Blob` / typed-array-shaped identifier by name
 *
 * Escaping it deliberately requires an inline disable *and* an ADR, per
 * AGENTS.md. The rule deliberately has no allowlist option: an exception that
 * lives in configuration is invisible at the call site.
 */

const NETWORK_CALLEES = new Set([
  "fetch",
  "sendBeacon",
  "send",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "request",
]);

const AXIOS_OBJECTS = new Set(["axios", "http", "api", "client"]);

const PAYLOAD_CONSTRUCTORS = new Set(["FormData", "Blob", "File"]);

/** Methods that turn a File/Blob into transferable content. */
const PAYLOAD_READERS = new Set([
  "arrayBuffer",
  "bytes",
  "stream",
  "slice",
  "getAsFile",
]);

/**
 * Names that all but certainly hold model bytes in this codebase. Naming is a
 * weak signal on its own, which is why it is only one of three checks.
 */
const PAYLOAD_NAME = /^(file|files|blob|bytes|buffer|arrayBuffer|payload|contents?|ifc|ifcBytes|bcf|bcfBytes|ids|idsXml|model|models|modelBytes|stepBytes|container)$/i;

/** @type {import('eslint').Rule.RuleModule} */
const noPayloadUploads = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid passing user model/issue/specification payloads to a network call",
    },
    schema: [],
    messages: {
      payload:
        "This looks like user content ({{what}}) being sent over the network. " +
        "IFC, BCF and IDS data must never leave the browser — see AGENTS.md §1. " +
        "If this really is not a payload, rename it; if it really is, you need an ADR.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /** Is this call expression a network call? */
    function isNetworkCall(node) {
      const callee = node.callee;

      if (callee.type === "Identifier") {
        return callee.name === "fetch";
      }
      if (callee.type !== "MemberExpression" || callee.computed) return false;

      const method = callee.property.name;
      if (!NETWORK_CALLEES.has(method)) return false;

      // `xhr.send(...)`, `socket.send(...)`, `navigator.sendBeacon(...)`.
      // Checked before the receiver, because the receiver of a `send` is a
      // local variable whose name we cannot enumerate.
      if (method === "send" || method === "sendBeacon") return true;

      const object = callee.object;
      if (object.type === "Identifier") {
        // `axios.post(...)`, `api.put(...)`
        return AXIOS_OBJECTS.has(object.name);
      }
      return false;
    }

    /** Describe why `node` looks like a payload, or return null. */
    function classify(node, seen = new Set()) {
      if (!node || seen.has(node)) return null;
      seen.add(node);

      switch (node.type) {
        case "NewExpression":
          if (
            node.callee.type === "Identifier" &&
            PAYLOAD_CONSTRUCTORS.has(node.callee.name)
          ) {
            return `a new ${node.callee.name}`;
          }
          return null;

        case "AwaitExpression":
          return classify(node.argument, seen);

        case "CallExpression": {
          const callee = node.callee;
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier" &&
            PAYLOAD_READERS.has(callee.property.name)
          ) {
            return `the result of .${callee.property.name}()`;
          }
          return null;
        }

        case "Identifier":
          return classifyIdentifier(node, seen);

        case "ObjectExpression": {
          // `{ body: bytes }` and `{ data: file }` — the shapes fetch and axios
          // actually take.
          for (const property of node.properties) {
            if (
              property.type !== "Property" ||
              property.computed ||
              property.key.type !== "Identifier"
            ) {
              continue;
            }
            if (property.key.name !== "body" && property.key.name !== "data") {
              continue;
            }
            const reason = classify(property.value, seen);
            if (reason) return reason;
          }
          return null;
        }

        default:
          return null;
      }
    }

    function classifyIdentifier(node, seen) {
      const scope = sourceCode.getScope(node);
      const variable = findVariable(scope, node.name);

      // Follow the binding: `const bytes = await file.arrayBuffer()` is the
      // exact mistake this rule exists for.
      if (variable) {
        for (const def of variable.defs) {
          if (def.type === "Variable" && def.node.init) {
            const reason = classify(def.node.init, seen);
            if (reason) return `\`${node.name}\`, ${reason}`;
          }
        }
      }

      if (PAYLOAD_NAME.test(node.name)) {
        return `\`${node.name}\``;
      }
      return null;
    }

    function findVariable(scope, name) {
      for (let current = scope; current; current = current.upper) {
        const found = current.variables.find((v) => v.name === name);
        if (found) return found;
      }
      return null;
    }

    return {
      CallExpression(node) {
        if (!isNetworkCall(node)) return;

        for (const argument of node.arguments) {
          const what = classify(argument);
          if (what) {
            context.report({ node: argument, messageId: "payload", data: { what } });
            return;
          }
        }
      },
    };
  },
};

export default noPayloadUploads;
