export type OpType = "Stake" | "Burn" | "BurnEngine" | "FeeClaim" | "Buyback" | "StrategicBuy" | string;

export interface Operation {
  type: string;
  op_type: OpType;
  buy_amount: number | null;
  buy_currency: string | null;
  sell_amount: number | null;
  sell_currency: string | null;
  exchange: string;
  weth_price_usd: number | null;
  token_price_usd: number | null;
  tx_hash: string;
  date_utc: string;
}

export interface Candle {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_usd: number;
  swaps: number;
}

export interface WidgetData {
  operations: Operation[];
  candles: Candle[];
  cache: {
    data: {
      totalManagedUsd: number;
      tusdBurnedNum: number;
      engineBurned: number;
      tusdPriceUsd: number;
      tusdSupplyNum: number;
      tusdStakedNum: number;
      tusdLiquidStakedNum: number;
      tusdBalNum: number;
    };
    updated_at: string;
  };
}
