﻿import {
  CompletionItemKind,
  Range,
  CompletionItem,
  Location,
  SignatureInformation,
  Hover,
  DocumentSymbol,
  LocationLink,
} from "vscode";

import { FunctionItem } from "./spFunctionItem";
import { MethodItem } from "./spMethodItem";
import { MethodMapItem } from "./spMethodmapItem";
import { EnumStructItem } from "./spEnumStructItem";
import { VariableItem } from "./spVariableItem";

export interface SPItem {
  name: string;
  kind: CompletionItemKind;
  filePath?: string;
  type?: string;
  parent?: SPItem;
  description?: string;
  range?: Range;
  detail?: string;
  fullRange?: Range;
  references?: Location[];
  params?: VariableItem[];
  deprecated?: string;

  toCompletionItem(
    lastFunc?: MethodItem | FunctionItem | undefined,
    lastESOrMM?: MethodMapItem | EnumStructItem | undefined,
    location?: Location,
    override?: boolean
  ): CompletionItem | undefined;
  toDefinitionItem(): LocationLink | undefined;
  toReferenceItem?(): Location[];
  toSignature(): SignatureInformation | undefined;
  toHover(): Hover | undefined;
  toDocumentSymbol?(): DocumentSymbol | undefined;
}

export class Include {
  uri: string;
  range: Range;

  constructor(uri: string, range: Range) {
    this.uri = uri;
    this.range = range;
  }
}
