import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "./sequelize";

interface ResourceTargetAttributes {
  id: number;
  code: string;
  theater_id: string;
  url: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

type ResourceTargetCreationAttributes = Optional<ResourceTargetAttributes, "id" | "created_at" | "updated_at">;

export class ResourceTarget
  extends Model<ResourceTargetAttributes, ResourceTargetCreationAttributes>
  implements ResourceTargetAttributes
{
  declare id: number;
  declare code: string;
  declare theater_id: string;
  declare url: string;
  declare enabled: boolean;
  declare created_at: Date;
  declare updated_at: Date;
}

ResourceTarget.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    code: { type: DataTypes.STRING(128), allowNull: false },
    theater_id: { type: DataTypes.STRING(32), allowNull: false },
    url: { type: DataTypes.STRING(2048), allowNull: false, unique: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  },
  {
    sequelize,
    tableName: "target",
    createdAt: "created_at",
    updatedAt: "updated_at"
  }
);
