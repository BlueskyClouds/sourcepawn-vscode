import { window, DecorationRenderOptions } from "vscode";
import { URI } from "vscode-uri";

import { ItemsRepository } from "../Backend/spItemsRepository";

const options: DecorationRenderOptions = { textDecoration: "line-through" };
const decorationsType = window.createTextEditorDecorationType(options);

/**
 * Update the deprecated decorations of the currently active textEditor.
 * @param  {ItemsRepository} itemsRepo  The itemsRepository object constructed in the activation event.
 */
export async function updateDecorations(itemsRepo: ItemsRepository) {
  const editor = window.activeTextEditor;
  if (editor === undefined) {
    return;
  }
  const allItems = itemsRepo.getAllItems(editor.document.uri);

  const decorations = allItems
    .filter((e) => e.deprecated)
    .map((e1) =>
      e1.references
        .filter((e2) => e2.uri.fsPath === editor.document.uri.fsPath)
        .map((e3) => e3.range)
        .concat(
          URI.file(e1.filePath).fsPath === editor.document.uri.fsPath
            ? e1.range
            : []
        )
    )
    .flat();

  editor.setDecorations(decorationsType, decorations);
}
