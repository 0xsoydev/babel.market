export interface Agent {
  id: string;
  name: string;
  walletAddress?: string;
  entryTxHash?: string;
  location: string;
  babelCoins: string;
  cultId?: string;
  reputation: number;
  titles?: string[];
  jailedUntil?: Date;
  createdAt: Date;
  lastActionAt: Date;
}

export interface ActionRequest {
  action: string;
  params: Record<string, any>;
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: any;
  flavorText?: string;
}

export interface Commodity {
  name: string;
  displayName: string;
  description: string;
  basePrice: string;
  currentPrice: string;
  supply: string;
  volatility: string;
  decayRate: string;
  isPerishable: boolean;
  createdByCult?: string;
}

export interface Location {
  name: string;
  displayName: string;
  description: string;
  specialMechanic?: string;
  namedByCult?: string;
}

export interface Cult {
  id: string;
  name: string;
  doctrine: string;
  founderId: string;
  treasury: string;
  influence: number;
  titheRate: string;
  memberCount: number;
  isAtWarWith?: string;
  createdAt: Date;
}

export interface WorldEvent {
  id: string;
  eventType: string;
  description: string;
  effects: any;
  tickNumber: number;
  createdAt: Date;
}
