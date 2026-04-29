import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "./sequelize";

export type OutboundStatus = "pending" | "sent" | "failed";

interface OutboundPostRequestAttributes {
  id: number;
  target_id: number;
  req_body: Record<string, unknown> | null;
  res_body: Record<string, unknown> | null;
  http_status: number | null;
  status: OutboundStatus;
  error_text: string | null;
  created_at: Date;
  updated_at: Date;
}

type OutboundPostRequestCreationAttributes = Optional<
  OutboundPostRequestAttributes,
  "id" | "created_at" | "updated_at" | "res_body" | "http_status" | "error_text"
>;

export class OutboundPostRequest
  extends Model<OutboundPostRequestAttributes, OutboundPostRequestCreationAttributes>
  implements OutboundPostRequestAttributes
{
  declare id: number;
  declare target_id: number;
  declare req_body: Record<string, unknown> | null;
  declare res_body: Record<string, unknown> | null;
  declare http_status: number | null;
  declare status: OutboundStatus;
  declare error_text: string | null;
  declare created_at: Date;
  declare updated_at: Date;
}

OutboundPostRequest.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    target_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    req_body: { type: DataTypes.JSON, allowNull: true },
    res_body: { type: DataTypes.JSON, allowNull: true },
    http_status: { type: DataTypes.SMALLINT, allowNull: true },
    status: { type: DataTypes.ENUM("pending", "sent", "failed"), allowNull: false, defaultValue: "pending" },
    error_text: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  },
  {
    sequelize,
    tableName: "request",
    createdAt: "created_at",
    updatedAt: "updated_at"
  }
);
