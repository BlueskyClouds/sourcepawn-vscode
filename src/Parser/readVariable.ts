﻿import { SyntaxNode } from "web-tree-sitter";

import { globalItem } from "../Misc/spConstants";
import { VariableItem } from "../Backend/Items/spVariableItem";
import { pointsToRange } from "./utils";
import { TreeWalker } from "./spParser";
import { ConstantItem } from "../Backend/Items/spConstantItem";
import { FunctionItem } from "../Backend/Items/spFunctionItem";
import { MethodItem } from "../Backend/Items/spMethodItem";

export type VariableParent = ConstantItem | FunctionItem | MethodItem;

/**
 * Process a variable declaration.
 * @param  {TreeWalker} walker        TreeWalker object.
 * @param  {SyntaxNode} node          Node to process.
 * @param  {VariableParent} parent    Parent of the variable. Defaults to globalItem.
 * @returns void
 */
export function readVariable(
  walker: TreeWalker,
  node: SyntaxNode,
  parent: VariableParent = globalItem
): void {
  const variableTypeNode = node.childForFieldName("type");
  const storageClass: string[] = [];
  for (const child of node.children) {
    if (child.type === "variable_storage_class") {
      storageClass.push(child.text);
      continue;
    }
    if (
      child.type !== "variable_declaration" &&
      child.type !== "old_variable_declaration"
    ) {
      continue;
    }
    const dimension = child.children
      .filter((e) => e.type === "fixed_dimension" || e.type === "dimension")
      .map((e) => e.text)
      .join("");
    const declaration = child.childForFieldName("name");
    let variableType =
      variableTypeNode?.text || child.childForFieldName("type")?.text;

    let variableName = declaration.text;
    if (
      variableType !== "" &&
      variableName === "" &&
      walker.fileItem.items.length > 0
    ) {
      // Assume we are in a `int foo, baz;` style declaration.
      variableName = variableType;
      variableType =
        walker.fileItem.items[walker.fileItem.items.length - 1].type;
    }
    const variableItem = new VariableItem(
      variableName,
      walker.filePath,
      parent,
      pointsToRange(declaration.startPosition, declaration.endPosition),
      variableType?.replace(":", ""),
      `${storageClass.join(" ")} ${variableType} ${
        declaration.text
      }${dimension}`,
      "",
      storageClass
    );
    walker.fileItem.items.push(variableItem);
  }
}
