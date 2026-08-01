export type CreatorConfig = {
  clientId: string;
  clientSecret: string;
  partnerTag: string;
  region: "NA" | "EU" | "FE";
  marketplace: string;
};

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

const LWA_ENDPOINTS = {
  NA: "https://api.amazon.com/auth/o2/token",
  EU: "https://api.amazon.co.uk/auth/o2/token",
  FE: "https://api.amazon.co.jp/auth/o2/token",
};

const COGNITO_ENDPOINTS = {
  NA: "https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token",
  EU: "https://creatorsapi.auth.eu-west-1.amazoncognito.com/oauth2/token",
  FE: "https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token",
};

async function getAccessToken(config: CreatorConfig): Promise<string> {
  const cached = tokenCache.get(config.clientId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const isV3 = config.clientId.startsWith("amzn1.");
  let res: Response;

  if (isV3) {
    const endpoint = LWA_ENDPOINTS[config.region] || LWA_ENDPOINTS.NA;
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "creatorsapi::default",
    });

    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } else {
    const endpoint = COGNITO_ENDPOINTS[config.region] || COGNITO_ENDPOINTS.NA;
    const authString = btoa(`${config.clientId}:${config.clientSecret}`);
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "creatorsapi/default",
    });

    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${authString}`
      },
      body: params.toString(),
    });
  }

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Creators API Authentication failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(config.clientId, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // refresh 60s early
  });

  return data.access_token;
}

export type CreatorSearchItem = {
  asin?: string;
  detailPageURL?: string;
  images?: {
    primary?: {
      small?: { url?: string };
    }
  };
  itemInfo?: {
    title?: { displayValue?: string };
    features?: { displayValues?: string[] };
  };
  offersV2?: {
    listings?: Array<{ price?: { money?: { displayAmount?: string } } }>;
  };
  score?: number;
};

export async function searchCreatorsItems(query: string, limit: number, config: CreatorConfig): Promise<CreatorSearchItem[]> {
  const token = await getAccessToken(config);
  const isV3 = config.clientId.startsWith("amzn1.");
  
  let authHeader = `Bearer ${token}`;
  if (!isV3) {
    const versionMap = { NA: "2.1", EU: "2.2", FE: "2.3" };
    authHeader = `Bearer ${token}, Version ${versionMap[config.region] || "2.1"}`;
  }

  const res = await fetch("https://creatorsapi.amazon/catalog/v1/searchItems", {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "x-marketplace": config.marketplace,
    },
    body: JSON.stringify({
      keywords: query,
      marketplace: config.marketplace,
      partnerTag: config.partnerTag,
      resources: [
        "images.primary.small",
        "itemInfo.title",
        "itemInfo.features",
        "offersV2.listings.price"
      ]
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Creators API searchItems failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { searchResult?: { items?: CreatorSearchItem[] } };
  return (data.searchResult?.items || []).slice(0, limit);
}

export async function getCreatorsItems(asins: string[], config: CreatorConfig): Promise<CreatorSearchItem[]> {
  const token = await getAccessToken(config);
  const isV3 = config.clientId.startsWith("amzn1.");
  
  let authHeader = `Bearer ${token}`;
  if (!isV3) {
    const versionMap = { NA: "2.1", EU: "2.2", FE: "2.3" };
    authHeader = `Bearer ${token}, Version ${versionMap[config.region] || "2.1"}`;
  }

  const res = await fetch("https://creatorsapi.amazon/catalog/v1/getItems", {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "x-marketplace": config.marketplace,
    },
    body: JSON.stringify({
      itemIds: asins,
      itemIdType: "ASIN",
      marketplace: config.marketplace,
      partnerTag: config.partnerTag,
      resources: [
        "images.primary.small",
        "itemInfo.title",
        "itemInfo.features",
        "offersV2.listings.price"
      ]
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Creators API getItems failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { itemsResult?: { items?: CreatorSearchItem[] } };
  return data.itemsResult?.items || [];
}
