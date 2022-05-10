import {
  TextDocumentChangeEvent,
  FileCreateEvent,
  workspace as Workspace,
  CompletionItemKind,
  TextDocumentContentChangeEvent,
  Range,
  Location,
  Position,
} from "vscode";
import { URI } from "vscode-uri";
import { resolve, dirname, join, extname } from "path";
import { existsSync } from "fs";

import { ItemsRepository } from "./spItemsRepository";
import { Include, SPItem } from "./Items/spItems";
import { FileItem } from "./spFilesRepository";
import { parseText, parseFile } from "../Parser/spParser";
import { getAllMethodmaps } from "./spItemsGetters";
import { MethodMapItem } from "./Items/spMethodmapItem";
import { EnumStructItem } from "./Items/spEnumStructItem";
import { FunctionItem } from "./Items/spFunctionItem";
import { EnumItem } from "./Items/spEnumItem";
import { globalItem } from "../Misc/spConstants";

/**
 * Handle the addition of a document by forwarding it to the newDocumentCallback function.
 * @param  {ItemsRepository} itemsRepo      The itemsRepository object constructed in the activation event.
 * @param  {FileCreateEvent} event          The file created event triggered by the creation of the file.
 * @returns void
 */
export function handleAddedDocument(
  itemsRepo: ItemsRepository,
  event: FileCreateEvent
): void {
  event.files.forEach((e) => newDocumentCallback(itemsRepo, e));
}

/**
 * Handle the changes in a document by creating a new FileItem object and parsing the file, even if it wasn't saved.
 * @param  {ItemsRepository} itemsRepo      The itemsRepository object constructed in the activation event.
 * @param  {TextDocumentChangeEvent} event  The document change event triggered by the file change.
 * @returns void
 */
export async function handleDocumentChange(
  itemsRepo: ItemsRepository,
  event: TextDocumentChangeEvent
): Promise<void> {
  if (
    !/\.(?:sp|inc)$/.test(event.document.uri.fsPath) ||
    event.contentChanges.length === 0
  ) {
    return;
  }

  // Hack to make the function non blocking, and not prevent the completionProvider from running.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const fileUri = event.document.uri.toString();
  const filePath = event.document.uri.fsPath.replace(".git", "");

  let fileItems = new FileItem(fileUri);
  itemsRepo.documents.set(fileUri, false);
  return new Promise((resolve, reject) => {
    let range: Range;
    let scopeRange: Range;
    let diffLength = 0;
    const allItems = itemsRepo.getAllItems(event.document.uri);

    // FIXME: This does not work for modifications in separate scopes.
    // The break statement below needs to be handled.
    // TODO: Handle global scopes between two other scopes.
    for (let change of event.contentChanges) {
      if (range === undefined) {
        scopeRange = getScope(itemsRepo, fileUri, change);
        if (!scopeRange) {
          break;
        }
        range = scopeRange.with();
      } else if (!range.contains(change.range)) {
        break;
      }
      if (change.text === "") {
        diffLength = change.range.start.line - change.range.end.line;
      } else {
        diffLength = (change.text.match(/\n/gm) || []).length;
      }
      range = new Range(
        range.start.line,
        range.start.character,
        range.end.line + diffLength,
        range.end.character
      );
    }

    shiftItems(allItems, event.contentChanges, event.document.uri);
    return;

    const text = event.document.getText(range);
    try {
      // We use parseText here, otherwise, if the user didn't save the file, the changes wouldn't be registered.
      parseText(
        text,
        filePath,
        fileItems,
        itemsRepo,
        false,
        false,
        range ? range.start.line : undefined
      );

      readUnscannedImports(itemsRepo, fileItems.includes);
      // TODO: Select allItems from mainpath instead.

      let oldRefs: Map<string, Location[]>;
      if (scopeRange) {
        oldRefs = cleanAllItems(
          allItems,
          scopeRange,
          range.end.line - scopeRange.end.line,
          event.document.uri
        );
        restoreOldRefs(oldRefs, fileItems, scopeRange, event.document.uri);
        // oldFileItem.items = oldFileItem.items.concat(fileItems.items);
        // oldFileItem.tokens = fileItems.tokens;
      } else {
        itemsRepo.fileItems.set(fileUri, fileItems);
      }

      resolveMethodmapInherits(itemsRepo, event.document.uri);

      parseText(
        text,
        filePath,
        fileItems,
        itemsRepo,
        true,
        false,
        range ? range.start.line : undefined,
        range
      );
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
}

/**
 * Regroup informations as to how to shift ranges in a file.
 */
export interface RangeShifter {
  /**
   * The position of the change.
   */
  pos: Position;

  /**
   * The amount of lines to shift. Can be negative.
   */
  lineShift: number;

  /**
   * The amount of characters to shift. Cannot be negative.
   */
  charShift: number;
}

/**
 * Shift the appropriate items' range, fullrange and references, given an array of changes.
 * @param  {SPItem[]} allItems  All the items that can possibly be shifted.
 * @param  {readonlyTextDocumentContentChangeEvent[]} changes  The array of changes.
 * @param  {URI} uri  The URI of the document being edited.
 * @returns void
 */
function shiftItems(
  allItems: SPItem[],
  changes: readonly TextDocumentContentChangeEvent[],
  uri: URI
): void {
  for (let change of changes) {
    const shift = getOffsetFromChange(change);
    for (let item of allItems) {
      if (item.filePath === uri.fsPath) {
        if (item.range) {
          item.range = shiftRange(item.range, shift);
        }
        if (item.fullRange) {
          item.fullRange = shiftRange(item.fullRange, shift);
        }
      }

      if (!item.references) {
        continue;
      }
      for (let ref of item.references) {
        if (ref.uri.fsPath === uri.fsPath) {
          ref.range = shiftRange(ref.range, shift);
        }
      }
    }
  }
}

/**
 * Return a new shifted range given a RangeShifter object.
 * Assumes the range is in the same document as the change.
 * @param  {Range} initial  The initial range to shift.
 * @param  {RangeShifter} shift  The RangeShifter object.
 * @returns Range  The shifted range.
 */
function shiftRange(initial: Range, shift: RangeShifter): Range {
  // The modification **adds** a string.
  if (initial.start.isBefore(shift.pos) && initial.end.isAfter(shift.pos)) {
    // The modification is **inside** the initial range.
    // We expand the range.
    if (initial.end.line === shift.pos.line) {
      // The modifications are on the same line as the end of the range.
      // We shift the characters as well.
      return new Range(
        initial.start.line,
        initial.start.character,
        initial.end.line + shift.lineShift,
        initial.end.character + shift.charShift
      );
    }
    if (
      shift.lineShift < 0 &&
      shift.pos.line - shift.lineShift === initial.end.line
    ) {
      // Special case when deleting lines.
      return new Range(
        initial.start.line,
        initial.start.character,
        shift.pos.line,
        shift.pos.character + initial.end.character
      );
    }
    // The modifications are not on the same line as the end of the range.
    // We only shift the line.
    return new Range(
      initial.start.line,
      initial.start.character,
      initial.end.line + shift.lineShift,
      initial.end.character
    );
  }

  if (shift.pos.line > initial.start.line) {
    // The modification occurs after, don't shift the range.
    return initial;
  }

  if (shift.pos.line < initial.start.line) {
    // The modification is after the initial range, on a different line.
    if (
      shift.lineShift < 0 &&
      shift.pos.line - shift.lineShift === initial.start.line
    ) {
      // Special case when deleting lines.
      return new Range(
        shift.pos.line,
        shift.pos.character + initial.start.character,
        shift.pos.line,
        shift.pos.character + initial.end.character
      );
    }
    // We shift the range down.
    return new Range(
      initial.start.line + shift.lineShift,
      initial.start.character,
      initial.end.line + shift.lineShift,
      initial.end.character
    );
  }

  // We are on the same line.
  if (shift.pos.character >= initial.end.character) {
    // The modification occurs after the last character of the range.
    // No changes are made, we return the initial range.
    return initial;
  }

  if (shift.lineShift > 0) {
    if (initial.start.line === initial.end.line) {
      // The start line and end line of the range are on the same line.
      // We shift everything.
      let startCharOffset = initial.start.character - shift.pos.character;
      let endCharOffset = initial.end.character - shift.pos.character;
      return new Range(
        initial.start.line + shift.lineShift,
        shift.charShift + startCharOffset,
        initial.end.line + shift.lineShift,
        shift.charShift + endCharOffset
      );
    }
    // The start line and end line of the range are on different lines.
    // We only shift the lines and the starting character.
    let startCharOffset = initial.start.character - shift.pos.character;
    return new Range(
      initial.start.line + shift.lineShift,
      shift.charShift + startCharOffset,
      initial.end.line + shift.lineShift,
      initial.end.character
    );
  }
  if (shift.lineShift === 0) {
    if (initial.start.line === initial.end.line) {
      // The start line and end line of the range are on the same line.
      // We shift it by the amount of characters.
      return new Range(
        initial.start.line,
        initial.start.character + shift.charShift,
        initial.end.line,
        initial.end.character + shift.charShift
      );
    }
    // The start line and end line of the range are on different lines.
    // We only shift the starting character.
    return new Range(
      initial.start.line,
      initial.start.character + shift.charShift,
      initial.end.line,
      initial.end.character
    );
  }
  return initial;
}

/**
 * Generate a RangeShift object from a change event.
 * @param  {TextDocumentContentChangeEvent} change  The change event to compute.
 * @returns RangeShifter  The computed RangeShifter object.
 */
function getOffsetFromChange(
  change: TextDocumentContentChangeEvent
): RangeShifter {
  const pos = new Position(
    change.range.start.line,
    change.range.start.character
  );
  if (change.text === "") {
    // This is a delete.
    return {
      pos,
      lineShift: change.range.start.line - change.range.end.line,
      charShift: change.range.start.character - change.range.end.character,
    };
  }
  let match = change.text.match(/\n/gm);
  if (!match) {
    return {
      pos,
      lineShift: 0,
      charShift: change.text.length,
    };
  }
  let newLinesCount = match.length;
  match = change.text.match(/\n(.+)$/gm);
  if (!match || match.length === 0) {
    return {
      pos,
      lineShift: newLinesCount,
      charShift: 0,
    };
  }
  return {
    pos,
    lineShift: newLinesCount,
    charShift: match[match.length - 1].length - 1,
  };
}

function restoreOldRefs(
  oldRefs: Map<string, Location[]>,
  fileItem: FileItem,
  range: Range,
  uri: URI
): void {
  for (let item of fileItem.items) {
    const parent = item.parent || globalItem;
    let oldItemRefs = oldRefs.get(`${item.name}-${parent.name}`);
    if (oldItemRefs === undefined) {
      continue;
    }
    oldItemRefs = oldItemRefs.filter(
      (e) => uri.fsPath !== e.uri.fsPath || !range.contains(e.range)
    );
    item.references.concat(oldItemRefs);
  }
}

function cleanAllItems(
  allItems: SPItem[],
  range: Range | undefined,
  offset: number,
  uri: URI
): Map<string, Location[]> {
  const oldRefs = new Map<string, Location[]>();

  if (range === undefined) {
    return oldRefs;
  }

  allItems = allItems.filter((e) => {
    // Keep the item if it does not have a range. Useful for hardcoded constants.
    if (!e.range) {
      return true;
    }

    // Filter items based on if they are in the scope being parsed.
    if (range.contains(e.range) && uri.fsPath === e.filePath) {
      // Keep only the external (outside of the scope) references of the item.
      if (e.references && e.references.length > 0) {
        const parent = e.parent || globalItem;
        oldRefs.set(
          `${e.name}-${parent.name}`,
          e.references.filter(
            (ref) => range.contains(ref.range) && ref.uri.fsPath === uri.fsPath
          )
        );
      }
      return false;
    }

    // Offset the ranges below the scope.
    if (range.end.line <= e.range.start.line) {
      e.range = addLineOffsetToRange(e.range, offset);
      if (e.fullRange) {
        e.fullRange = addLineOffsetToRange(e.fullRange, offset);
      }
    }

    // Offset the references below the scope.
    if (e.references) {
      for (let ref of e.references) {
        if (
          range.end.line <= ref.range.start.line &&
          ref.uri.fsPath === uri.fsPath
        ) {
          ref.range = addLineOffsetToRange(ref.range, offset);
        }
      }
    }
    return true;
  });

  return oldRefs;
}

function addLineOffsetToRange(range: Range, offset: number): Range {
  return new Range(
    range.start.line + offset,
    range.start.character,
    range.end.line + offset,
    range.end.character
  );
}

function getScope(
  itemsRepo: ItemsRepository,
  uri: string,
  changes: TextDocumentContentChangeEvent
): Range | undefined {
  const localItems = itemsRepo.fileItems.get(uri).items;
  const MmEsEnFu = [
    CompletionItemKind.Class,
    CompletionItemKind.Struct,
    CompletionItemKind.Enum,
    CompletionItemKind.Function,
  ];
  let prevScope: SPItem;
  let scope: MethodMapItem | EnumStructItem | FunctionItem | EnumItem;

  let scopes = localItems.filter((e) => {
    if (MmEsEnFu.includes(e.kind)) {
      if (e.fullRange && e.fullRange.contains(changes.range)) {
        scope = e as MethodMapItem | EnumStructItem | FunctionItem | EnumItem;
      }
      return true;
    }
    return false;
  });

  if (scope === undefined) {
    return undefined;
  }

  scopes = scopes.sort(
    (a, b) => a.fullRange.start.line - b.fullRange.start.line
  );

  const endLine = scope.fullRange.end.line + computeEditRange(changes);

  let scopeIdx = scopes.findIndex((e) => e === scope);
  if (scopeIdx == 0 || undefined) {
    return new Range(0, 0, endLine + 1, 0);
  }
  prevScope = scopes[scopeIdx - 1];

  const startLine = prevScope.fullRange.end.line;

  return new Range(
    startLine + 1,
    0,
    endLine + 1,
    scope.fullRange.end.character
  );
}

function computeEditRange(changes: TextDocumentContentChangeEvent): number {
  // Handle delete changes.
  if (changes.text === "") {
    return changes.range.start.line - changes.range.end.line;
  }
  // Handle other changes.
  return (changes.text.match(/\n/gm) || []).length;
}

/**
 * Generic callback for newly added/created documents. Parses the file.
 * @param  {ItemsRepository} itemsRepo    The itemsRepository object constructed in the activation event.
 * @param  {URI} uri                      The URI of the document.
 * @returns void
 */
export function newDocumentCallback(
  itemsRepo: ItemsRepository,
  uri: URI
): void {
  const filePath = uri.fsPath;

  if (itemsRepo.fileItems.has(uri.toString())) {
    // Don't parse the document again if it was already.
    return;
  }

  if (
    ![".inc", ".sp"].includes(extname(uri.fsPath)) ||
    filePath.includes(".git")
  ) {
    return;
  }

  let fileItems: FileItem = new FileItem(uri.toString());
  itemsRepo.documents.set(uri.toString(), false);
  try {
    parseFile(filePath, fileItems, itemsRepo, false, false);
  } catch (error) {
    console.error(error);
  }
  readUnscannedImports(itemsRepo, fileItems.includes);
  itemsRepo.fileItems.set(uri.toString(), fileItems);

  resolveMethodmapInherits(itemsRepo, uri);

  // Parse token references.
  parseFile(filePath, fileItems, itemsRepo, true, false);
  itemsRepo.fileItems.forEach((fileItems, k) => {
    fileItems.includes.forEach((e) => {
      const uri = URI.parse(e.uri);
      if (itemsRepo.documents.get(uri.toString())) {
        return;
      }
      parseFile(
        uri.fsPath,
        itemsRepo.fileItems.get(uri.toString()),
        itemsRepo,
        true,
        false
      );
      itemsRepo.documents.set(uri.toString(), true);
    });
  });
}

/**
 * Recursively read the unparsed includes from a array of Include objects.
 * @param  {ItemsRepository} itemsRepo    The itemsRepository object constructed in the activation event.
 * @param  {Include[]} includes           The array of Include objects to parse.
 * @returns void
 */
function readUnscannedImports(
  itemsRepo: ItemsRepository,
  includes: Include[]
): void {
  const debug = ["messages", "verbose"].includes(
    Workspace.getConfiguration("sourcepawn").get("trace.server")
  );
  includes.forEach((include) => {
    if (debug) console.log("reading", include.uri.toString());

    const filePath = URI.parse(include.uri).fsPath;

    if (itemsRepo.fileItems.has(include.uri) || !existsSync(filePath)) {
      return;
    }

    if (debug) console.log("found", include.uri.toString());

    let fileItems: FileItem = new FileItem(include.uri);
    try {
      parseFile(filePath, fileItems, itemsRepo, false, include.IsBuiltIn);
    } catch (err) {
      console.error(err, include.uri.toString());
    }
    if (debug) console.log("parsed", include.uri.toString());

    itemsRepo.fileItems.set(include.uri, fileItems);
    if (debug) console.log("added", include.uri.toString());

    readUnscannedImports(itemsRepo, fileItems.includes);
  });
}

/**
 * Return all the possible include directories paths, such as SMHome, etc. The function will only return existing paths.
 * @param  {URI} uri                          The URI of the file from which we are trying to read the include.
 * @param  {boolean=false} onlyOptionalPaths  Whether or not the function only return the optionalIncludeFolderPaths.
 * @returns string
 */
export function getAllPossibleIncludeFolderPaths(
  uri: URI,
  onlyOptionalPaths = false
): string[] {
  let possibleIncludePaths: string[] = [];
  const workspaceFolder = Workspace.getWorkspaceFolder(uri);

  possibleIncludePaths = Workspace.getConfiguration(
    "sourcepawn",
    workspaceFolder
  ).get("optionalIncludeDirsPaths");
  possibleIncludePaths = possibleIncludePaths.map((e) =>
    resolve(workspaceFolder === undefined ? "" : workspaceFolder.uri.fsPath, e)
  );

  if (onlyOptionalPaths) {
    return possibleIncludePaths;
  }

  const smHome = Workspace.getConfiguration(
    "sourcepawn",
    workspaceFolder
  ).get<string>("SourcemodHome");

  if (smHome !== undefined) {
    possibleIncludePaths.push(smHome);
  }

  const scriptingFolder = dirname(uri.fsPath);
  possibleIncludePaths.push(scriptingFolder);
  possibleIncludePaths.push(join(scriptingFolder, "include"));

  return possibleIncludePaths.filter((e) => e !== "" && existsSync(e));
}

/**
 * Deal with all the tmpParents properties of methodmaps items post parsing.
 * @param  {ItemsRepository} itemsRepo The itemsRepository object constructed in the activation event.
 * @param  {URI} uri  The uri of the document to check the methodmaps for (will check the includes as well).
 * @returns void
 */
function resolveMethodmapInherits(itemsRepo: ItemsRepository, uri: URI): void {
  const methodmaps = getAllMethodmaps(itemsRepo, uri);
  methodmaps.forEach((v, k) => {
    if (v.tmpParent === undefined) {
      return;
    }
    const parent = methodmaps.get(v.tmpParent);
    if (parent === undefined) {
      return;
    }
    v.parent = parent;
    v.tmpParent = undefined;
  });
}
