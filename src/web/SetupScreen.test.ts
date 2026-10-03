import { describe, expect, it } from "vitest";
import { errorText } from "./SetupScreen";
import { GitHubError } from "./types";

describe("opsætningens fejltekster", () => {
  it("ukendt branch nævnes ved navn i stedet for 'repoet blev ikke fundet'", () => {
    const err = new GitHubError("not-found", "Branchen mian findes ikke i pindulet/notes", 404);
    expect(errorText(err, "pindulet/notes", "k")).toBe("Branchen mian findes ikke i pindulet/notes.");
  });

  it("ukendt repo peger stadig på nøglens adgang", () => {
    const err = new GitHubError("not-found", "Repoet eller branchen blev ikke fundet", 404);
    expect(errorText(err, "pindulet/notes", "k")).toBe(
      "Repoet blev ikke fundet — har nøglen adgang til pindulet/notes?"
    );
  });

  it("nøglen står aldrig i teksten", () => {
    expect(errorText(new Error("fejl med hemmelig-noegle"), "pindulet/notes", "hemmelig-noegle")).toBe("fejl med …");
  });
});
