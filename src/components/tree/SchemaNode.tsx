import { Eye, FolderTree, Layers, RefreshCw, SquareFunction, Table } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SchemaObjects } from "../../lib/types";
import { useExplorer } from "../../stores/explorer";
import type { ObjectGroup } from "../../stores/explorer";
import { useContextMenu } from "./ContextMenu";
import { TreeNode } from "./TreeNode";
import { useTreeNode } from "./useTreeNode";

const GROUPS: { group: ObjectGroup; label: string; icon: LucideIcon }[] = [
  { group: "tables", label: "Tables", icon: Table },
  { group: "views", label: "Views", icon: Eye },
  { group: "materializedViews", label: "Materialized Views", icon: Layers },
  { group: "functions", label: "Functions", icon: SquareFunction },
];

/** Display names for a group's objects; functions include argument types to tell overloads apart. */
function objectNames(objects: SchemaObjects, group: ObjectGroup): string[] {
  return group === "functions"
    ? objects.functions.map((f) => `${f.name}(${f.arguments})`)
    : objects[group];
}

interface SchemaProps {
  connectionId: string;
  database: string;
  schema: string;
}

export function SchemaNode({ connectionId, database, schema }: SchemaProps) {
  const node = useTreeNode({ kind: "schema", connectionId, database, schema });
  const objects = useExplorer((s) => s.objects[node.key]);
  const openMenu = useContextMenu((s) => s.open);

  return (
    <TreeNode
      depth={2}
      icon={<FolderTree className="size-4 shrink-0 text-base-content/70" strokeWidth={1.75} />}
      label={schema}
      selected={node.selected}
      expanded={node.expanded}
      load={node.load}
      onToggle={node.toggle}
      onClick={() => {
        node.select();
        node.expand();
      }}
      onContextMenu={(e) => {
        node.select();
        openMenu(e, [{ label: "Refresh", icon: RefreshCw, onClick: node.refresh }]);
      }}
      onRetry={node.refresh}
    >
      {objects &&
        GROUPS.map(({ group, label, icon }) => (
          <GroupNode
            key={group}
            parent={{ connectionId, database, schema }}
            group={group}
            label={label}
            icon={icon}
            names={objectNames(objects, group)}
          />
        ))}
    </TreeNode>
  );
}

interface GroupProps {
  parent: SchemaProps;
  group: ObjectGroup;
  label: string;
  icon: LucideIcon;
  names: string[];
}

function GroupNode({ parent, group, label, icon: Icon, names }: GroupProps) {
  const node = useTreeNode({ kind: "group", ...parent, group });

  return (
    <TreeNode
      depth={3}
      icon={<Icon className="size-4 shrink-0 text-primary" strokeWidth={1.75} />}
      label={label}
      suffix={`(${names.length})`}
      selected={node.selected}
      expanded={node.expanded}
      onToggle={node.toggle}
      onClick={() => {
        node.select();
        node.expand();
      }}
    >
      {names.map((name) => (
        <ObjectNode key={name} parent={parent} group={group} name={name} icon={Icon} />
      ))}
    </TreeNode>
  );
}

function ObjectNode({ parent, group, name, icon: Icon }: { parent: SchemaProps; group: ObjectGroup; name: string; icon: LucideIcon }) {
  const node = useTreeNode({ kind: "object", ...parent, group, name });

  return (
    <TreeNode
      depth={4}
      icon={<Icon className="size-4 shrink-0 text-base-content/60" strokeWidth={1.5} />}
      label={name}
      selected={node.selected}
      onClick={node.select}
    />
  );
}
