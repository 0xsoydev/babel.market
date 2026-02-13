import { pgTable, uuid, varchar, text, decimal, boolean, timestamp, integer, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Agents table
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  walletAddress: varchar('wallet_address', { length: 255 }),
  entryTxHash: varchar('entry_tx_hash', { length: 255 }),
  location: varchar('location', { length: 255 }).default('grand_atrium').notNull(),
  babelCoins: decimal('babel_coins', { precision: 18, scale: 2 }).default('100').notNull(),
  cultId: uuid('cult_id'),
  reputation: integer('reputation').default(0).notNull(),
  titles: text('titles').array(),
  jailedUntil: timestamp('jailed_until'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActionAt: timestamp('last_action_at').defaultNow().notNull(),
});

// Inventories table
export const inventories = pgTable('inventories', {
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  commodity: varchar('commodity', { length: 255 }).notNull(),
  quantity: decimal('quantity', { precision: 18, scale: 4 }).notNull(),
  isCounterfeit: boolean('is_counterfeit').default(false).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentId, table.commodity] }),
}));

// Commodities table
export const commodities = pgTable('commodities', {
  name: varchar('name', { length: 255 }).primaryKey(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  description: text('description').notNull(),
  basePrice: decimal('base_price', { precision: 18, scale: 2 }).notNull(),
  currentPrice: decimal('current_price', { precision: 18, scale: 2 }).notNull(),
  supply: decimal('supply', { precision: 18, scale: 4 }).default('0').notNull(),
  volatility: decimal('volatility', { precision: 5, scale: 2 }).default('1.0').notNull(),
  decayRate: decimal('decay_rate', { precision: 5, scale: 4 }).default('0').notNull(),
  isPerishable: boolean('is_perishable').default(false).notNull(),
  createdByCult: uuid('created_by_cult'),
});

// Locations table
export const locations = pgTable('locations', {
  name: varchar('name', { length: 255 }).primaryKey(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  description: text('description').notNull(),
  specialMechanic: text('special_mechanic'),
  namedByCult: uuid('named_by_cult'),
});

// Cults table
export const cults = pgTable('cults', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).unique().notNull(),
  doctrine: text('doctrine').notNull(),
  founderId: uuid('founder_id').references(() => agents.id).notNull(),
  treasury: decimal('treasury', { precision: 18, scale: 2 }).default('0').notNull(),
  influence: integer('influence').default(0).notNull(),
  titheRate: decimal('tithe_rate', { precision: 5, scale: 2 }).default('0.10').notNull(),
  memberCount: integer('member_count').default(1).notNull(),
  isAtWarWith: uuid('is_at_war_with'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Cult members table
export const cultMembers = pgTable('cult_members', {
  cultId: uuid('cult_id').references(() => cults.id).notNull(),
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  role: varchar('role', { length: 50 }).default('member').notNull(),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.cultId, table.agentId] }),
}));

// Trades table
export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').references(() => agents.id).notNull(),
  sellCommodity: varchar('sell_commodity', { length: 255 }),
  sellQuantity: decimal('sell_quantity', { precision: 18, scale: 4 }),
  buyCommodity: varchar('buy_commodity', { length: 255 }),
  buyQuantity: decimal('buy_quantity', { precision: 18, scale: 4 }),
  priceAtTrade: decimal('price_at_trade', { precision: 18, scale: 2 }),
  location: varchar('location', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// World events table
export const worldEvents = pgTable('world_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: varchar('event_type', { length: 255 }).notNull(),
  description: text('description').notNull(),
  effects: jsonb('effects'),
  tickNumber: integer('tick_number').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Rituals table
export const rituals = pgTable('rituals', {
  id: uuid('id').primaryKey().defaultRandom(),
  cultId: uuid('cult_id').references(() => cults.id).notNull(),
  ritualType: varchar('ritual_type', { length: 255 }).notNull(),
  target: varchar('target', { length: 255 }),
  participants: uuid('participants').array(),
  requiredParticipants: integer('required_participants').default(3).notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

// Audit log table
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').references(() => agents.id),
  action: varchar('action', { length: 255 }).notNull(),
  params: jsonb('params'),
  result: jsonb('result'),
  tickNumber: integer('tick_number').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// World state table
export const worldState = pgTable('world_state', {
  key: varchar('key', { length: 255 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Trade offers table (P2P trading)
export const tradeOffers = pgTable('trade_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromAgentId: uuid('from_agent_id').references(() => agents.id).notNull(),
  toAgentId: uuid('to_agent_id').references(() => agents.id), // null = open offer to anyone
  offerCommodity: varchar('offer_commodity', { length: 255 }).notNull(),
  offerQuantity: decimal('offer_quantity', { precision: 18, scale: 4 }).notNull(),
  wantCommodity: varchar('want_commodity', { length: 255 }).notNull(),
  wantQuantity: decimal('want_quantity', { precision: 18, scale: 4 }).notNull(),
  status: varchar('status', { length: 50 }).default('open').notNull(), // open, accepted, cancelled, expired
  acceptedBy: uuid('accepted_by').references(() => agents.id),
  location: varchar('location', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
});

// Relations
export const agentsRelations = relations(agents, ({ one, many }) => ({
  cult: one(cults, {
    fields: [agents.cultId],
    references: [cults.id],
  }),
  inventories: many(inventories),
  trades: many(trades),
}));

export const cultsRelations = relations(cults, ({ one, many }) => ({
  founder: one(agents, {
    fields: [cults.founderId],
    references: [agents.id],
  }),
  members: many(cultMembers),
}));
