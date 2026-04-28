import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "./sequelize";

export type ResourceStatus = "key_ok" | "key_false" | "unreachable" | "error" | "auth" | "key_error";

interface ResourceStatusLogAttributes {
  id: number;
  target_id: number;
  status: ResourceStatus;
  details: string | null;
  detected_at: Date;
  created_at: Date;
}

type ResourceStatusLogCreationAttributes = Optional<ResourceStatusLogAttributes, "id" | "created_at">;

export class ResourceStatusLog
  extends Model<ResourceStatusLogAttributes, ResourceStatusLogCreationAttributes>
  implements ResourceStatusLogAttributes
{
  declare id: number;
  declare target_id: number;
  declare status: ResourceStatus;
  declare details: string | null;
  declare detected_at: Date;
  declare created_at: Date;
}

ResourceStatusLog.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    target_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    status: {
      type: DataTypes.ENUM("key_ok", "key_false", "unreachable", "error", "auth", "key_error"),
      allowNull: false
    },
    details: { type: DataTypes.TEXT, allowNull: true },
    detected_at: { type: DataTypes.DATE, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  },
  {
    sequelize,
    tableName: "status_log",
    createdAt: "created_at",
    updatedAt: false
  }
);
