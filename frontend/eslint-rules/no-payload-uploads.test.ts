import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./no-payload-uploads.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("no-payload-uploads", () => {
  it("passes its cases", () => {
    ruleTester.run("no-payload-uploads", rule, {
      valid: [
        // Auth and metadata — the only things allowed over the wire.
        `fetch("/api/auth/jwt/create", { method: "POST", body: JSON.stringify({ email, password }) });`,
        `axios.post("/api/projects/", { name: "Bridge" });`,
        // A digest is not a payload.
        `fetch("/api/trust/timestamp", { method: "POST", body: JSON.stringify({ digest }) });`,
        // Reading a file locally is fine — it is sending it that is not.
        `const bytes = await file.arrayBuffer(); worker.postMessage(bytes);`,
        // Not a network call.
        `logger.post({ file });`,
      ],

      invalid: [
        {
          // The mistake this rule exists for.
          code: `const bytes = await file.arrayBuffer();
                 fetch("/api/upload", { method: "POST", body: bytes });`,
          errors: [{ messageId: "payload" }],
        },
        {
          code: `const form = new FormData();
                 form.append("model", file);
                 axios.post("/api/models/", form);`,
          errors: [{ messageId: "payload" }],
        },
        {
          code: `fetch("/api/upload", { method: "POST", body: new Blob([ifc]) });`,
          errors: [{ messageId: "payload" }],
        },
        {
          code: `axios.put("/api/models/1/", { data: modelBytes });`,
          errors: [{ messageId: "payload" }],
        },
        {
          code: `navigator.sendBeacon("/api/telemetry", ifcBytes);`,
          errors: [{ messageId: "payload" }],
        },
        {
          code: `socket.send(bcfBytes);`,
          errors: [{ messageId: "payload" }],
        },
      ],
    });
  });
});
