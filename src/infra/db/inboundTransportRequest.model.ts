import { DataTypes, Model, Optional } from "sequelize";
import { transportSequelize } from "./transportSequelize";

export type InboundTransportStatus = "pending" | "processing" | "done" | "failed";

interface InboundTransportRequestAttributes {
  id: number;
  transport_code: string;
  app_code: string;
  bot_code: string;
  tg_chat_id: string;
  text: string;
  status: InboundTransportStatus;
  attempts: number;
  error_text: string | null;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

type InboundTransportRequestCreationAttributes = Optional<
  InboundTransportRequestAttributes,
  "id" | "status" | "attempts" | "error_text" | "processed_at" | "created_at" | "updated_at"
>;

export class InboundTransportRequest
  extends Model<InboundTransportRequestAttributes, InboundTransportRequestCreationAttributes>
  implements InboundTransportRequestAttributes
{
  declare id: number;
  declare transport_code: string;
  declare app_code: string;
  declare bot_code: string;
  declare tg_chat_id: string;
  declare text: string;
  declare status: InboundTransportStatus;
  declare attempts: number;
  declare error_text: string | null;
  declare processed_at: Date | null;
  declare created_at: Date;
  declare updated_at: Date;
}

InboundTransportRequest.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    transport_code: { type: DataTypes.STRING(64), allowNull: false },
    app_code: { type: DataTypes.STRING(64), allowNull: false },
    bot_code: { type: DataTypes.STRING(64), allowNull: false },
    tg_chat_id: { type: DataTypes.STRING(64), allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: false },
    status: {
      type: DataTypes.ENUM("pending", "processing", "done", "failed"),
      allowNull: false,
      defaultValue: "pending"
    },
    attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    error_text: { type: DataTypes.TEXT, allowNull: true },
    processed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
  },
  {
    sequelize: transportSequelize,
    tableName: "inbound_transport_request",
    createdAt: "created_at",
    updatedAt: "updated_at"
  }
);
