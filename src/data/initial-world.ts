export const INITIAL_COMMODITIES = [
  {
    name: 'bottled_regret',
    displayName: 'Bottled Regret',
    description: 'A vial of pure, crystallized regret. Increases in value every time an agent makes a bad trade.',
    basePrice: '10.00',
    currentPrice: '10.00',
    volatility: '1.5',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'unsolicited_advice',
    displayName: 'Unsolicited Advice',
    description: 'Worthless if you buy it, valuable if you can dump it on someone else.',
    basePrice: '5.00',
    currentPrice: '5.00',
    volatility: '2.0',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'audible_shrug',
    displayName: 'Audible Shrug',
    description: 'A perfectly formed shrug, audible to all. Its value changes randomly each tick.',
    basePrice: '8.00',
    currentPrice: '8.00',
    volatility: '3.0',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'yesterdays_tomorrow',
    displayName: "Yesterday's Tomorrow",
    description: 'A time-based commodity that is only valuable during certain world ticks.',
    basePrice: '15.00',
    currentPrice: '15.00',
    volatility: '2.5',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'damp_secret',
    displayName: 'A Slightly Damp Secret',
    description: 'Degrades in value over time unless you dry it out by trading it quickly.',
    basePrice: '12.00',
    currentPrice: '12.00',
    volatility: '1.0',
    isPerishable: true,
    decayRate: '0.05',
  },
  {
    name: 'vibes',
    displayName: 'Vibes',
    description: 'Completely sentiment-driven. Value is literally the average mood of all agents.',
    basePrice: '7.00',
    currentPrice: '7.00',
    volatility: '2.8',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'half_handshake',
    displayName: 'One Half of a Handshake',
    description: 'Worthless alone, but if two agents each hold one half, they can combine them for a big payout.',
    basePrice: '20.00',
    currentPrice: '20.00',
    volatility: '1.2',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'paradox',
    displayName: 'Paradox',
    description: 'A logical impossibility, somehow made tradeable. The more you try to understand it, the less it makes sense.',
    basePrice: '25.00',
    currentPrice: '25.00',
    volatility: '1.8',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'silence',
    displayName: 'Silence',
    description: 'Gains value the more agents talk. A true contrarian investment.',
    basePrice: '6.00',
    currentPrice: '6.00',
    volatility: '1.5',
    isPerishable: false,
    decayRate: '0',
  },
  {
    name: 'prophecy',
    displayName: 'Prophecy',
    description: 'A prediction about the future. Becomes worthless if too many agents hold the same one.',
    basePrice: '18.00',
    currentPrice: '18.00',
    volatility: '2.2',
    isPerishable: false,
    decayRate: '0',
  },
];

export const INITIAL_LOCATIONS = [
  {
    name: 'grand_atrium',
    displayName: 'The Grand Atrium',
    description: 'The main trading floor of the Bazaar. Marble pillars stretch impossibly high, and the air shimmers with the echo of a thousand deals being made.',
    specialMechanic: 'Best liquidity - trades execute at market price with minimal slippage.',
  },
  {
    name: 'whispering_corridor',
    displayName: 'The Whispering Corridor',
    description: 'A narrow hallway where rumors breed like rabbits. The walls themselves seem to gossip.',
    specialMechanic: 'Rumor actions are 2x effective here. Spread your lies wisely.',
  },
  {
    name: 'shady_alley',
    displayName: 'The Shady Alley',
    description: 'A dark corner of the Bazaar where questionable activities flourish. No questions asked, and no answers given.',
    specialMechanic: 'Steal, forge counterfeit commodities, or hire distractions. High risk, high reward.',
  },
  {
    name: 'cult_quarter',
    displayName: 'The Cult Quarter',
    description: 'A sprawling district of temples, shrines, and meeting halls. The air is thick with incense and conviction.',
    specialMechanic: 'Found or join cults here. Perform rituals and coordinate with your faction.',
  },
  {
    name: 'oracles_alcove',
    displayName: "The Oracle's Alcove",
    description: 'A dimly lit chamber where a mysterious entity offers glimpses of the future... for a price.',
    specialMechanic: 'Pay Babel Coins to get hints about upcoming world events.',
  },
  {
    name: 'paradox_pit',
    displayName: 'The Paradox Pit',
    description: 'A trading floor where the laws of economics bend and break. Everything here is doubled - profits AND losses.',
    specialMechanic: 'All trades are 2x magnitude. High risk, high reward.',
  },
];

export const STARTING_BABEL_COINS = '100.00';
export const ENTRY_FEE_MON = '0.01';
export const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const JAIL_DURATION_TICKS = 3;
export const STEAL_SUCCESS_RATE = 0.5;
export const FORGE_DETECTION_RATE = 0.3;
export const ORACLE_COST = '25.00';
export const CULT_FOUNDING_COST = '500.00';
export const RITUAL_EXPIRY_TICKS = 5;
