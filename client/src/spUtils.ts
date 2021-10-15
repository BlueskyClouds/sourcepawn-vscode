﻿import { MarkdownString, Uri, workspace as Workspace } from "vscode";
import { existsSync } from "fs";
import { join } from "path";

export function descriptionToMD(description: string): MarkdownString {
  if (description === undefined) {
    return new MarkdownString("");
  }
  description = description
    .replace(/\</gm, "\\<")
    .replace(/\>/gm, "\\>")
    .replace(/([^.])(\.) *[\n]+(?:\s*([^@\s.]))/gm, "$1. $3")
    .replace(/\s+\*\s*/gm, "\n\n");
  // Make all @ nicer
  description = description.replace(/\s*(@[A-Za-z]+)\s+/gm, "\n\n_$1_ ");
  // Make the @params nicer
  description = description.replace(
    /(\_@param\_) ([A-Za-z0-9_.]+)\s*/gm,
    "$1 `$2` — "
  );

  // Format other functions which are referenced in the description
  description = description.replace(
    /([A-Za-z0-9_]+\([A-Za-z0-9_ \:]*\))/gm,
    "`$1`"
  );
  return new MarkdownString(description);
}

export function findMainPath(uri?: Uri): string {
  let workspaceFolders = Workspace.workspaceFolders;
  let workspaceFolder =
    uri === undefined ? undefined : Workspace.getWorkspaceFolder(uri);
  let mainPath: string =
    Workspace.getConfiguration("sourcepawn", workspaceFolder).get("MainPath") ||
    "";
  if (mainPath !== "") {
    // Check if it exists, meaning it's an absolute path.
    if (!existsSync(mainPath) && workspaceFolders !== undefined) {
      // If it doesn't, loop over the workspace folders until one matches.
      for (let wk of workspaceFolders) {
        mainPath = join(wk.uri.fsPath, mainPath);
        if (existsSync(mainPath)) {
          return mainPath;
        }
      }
      return "";
    } else {
      return mainPath;
    }
  }
}
