import { useProfiles } from "@/lib/pipeline-profiles";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { searchAmazon } from "@/lib/amazon.functions";
import { useState } from "react";

export default function ProductsConfig({ profileId }: { profileId: string }) {
  const [testing, setTesting] = useState(false);
  const { profiles, save } = useProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  const stage = profile?.stages?.products;
  const overrides = stage?.overrides || {};

  if (!profile || !stage) return null;

  function update(key: string, value: string) {
    if (!profile || !stage) return;
    const p = JSON.parse(JSON.stringify(profile)); // Deep copy to mutate safely
    if (!p.stages.products.overrides) {
      p.stages.products.overrides = {};
    }
    p.stages.products.overrides[key] = value;
    save(p);
  }

  const mode = (overrides.amazonApiMode as string) || "creator";
  const useLambdaFallback = overrides.amazonUseLambdaFallback !== undefined 
    ? Boolean(overrides.amazonUseLambdaFallback) 
    : false;
  const clientId = (overrides.amazonClientId as string) || "";
  const clientSecret = (overrides.amazonClientSecret as string) || "";
  const partnerTag = (overrides.amazonPartnerTag as string) || "";
  const region = (overrides.amazonRegion as string) || "NA";
  const marketplace = (overrides.amazonMarketplace as string) || "www.amazon.com";

  async function handleTest() {
    setTesting(true);
    try {
      const res = await searchAmazon({
        data: {
          query: "laptop",
          limit: 1,
          config: {
            mode: mode as "creator" | "lambda",
            clientId,
            clientSecret,
            partnerTag,
            region: region as "NA" | "EU" | "FE",
            marketplace,
          }
        }
      });
      if (res.results.length > 0) {
        toast.success(`Success! Found ${res.results.length} item(s).`);
      } else {
        toast.warning("API call succeeded but returned 0 results.");
      }
    } catch (e: any) {
      toast.error(`Amazon API Error: ${e.message}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 text-sm text-muted-foreground mt-4">
      <div className="flex flex-col gap-3">
        <Label className="text-foreground font-semibold">Amazon API Mode</Label>
        <RadioGroup value={mode} onValueChange={(v) => update("amazonApiMode", v)} className="flex flex-col gap-2">
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="creator" id="mode-creator" />
            <Label htmlFor="mode-creator" className="cursor-pointer">Official Creators API (Recommended)</Label>
          </div>
          <div className="flex items-center space-x-2">
            <RadioGroupItem value="lambda" id="mode-lambda" />
            <Label htmlFor="mode-lambda" className="cursor-pointer">Lambda Fallback API</Label>
          </div>
        </RadioGroup>
      </div>

      {mode === "creator" && (
        <div className="flex flex-col gap-4 p-4 border rounded-md bg-muted/20">
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Client ID</Label>
            <Input 
              value={clientId} 
              onChange={(e) => update("amazonClientId", e.target.value)} 
              placeholder="amzn1.application-oa2-client..." 
            />
          </div>
          
          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Client Secret</Label>
            <Input 
              type="password"
              value={clientSecret} 
              onChange={(e) => update("amazonClientSecret", e.target.value)} 
              placeholder="Enter client secret" 
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-foreground">Partner Tag (Store ID)</Label>
            <Input 
              value={partnerTag} 
              onChange={(e) => update("amazonPartnerTag", e.target.value)} 
              placeholder="consecho-20" 
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">Region</Label>
              <select 
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={region}
                onChange={(e) => update("amazonRegion", e.target.value)}
              >
                <option value="NA">NA (North America)</option>
                <option value="EU">EU (Europe)</option>
                <option value="FE">FE (Far East)</option>
              </select>
            </div>
            
            <div className="flex flex-col gap-2">
              <Label className="text-foreground">Marketplace (Domain)</Label>
              <Input 
                value={marketplace} 
                onChange={(e) => update("amazonMarketplace", e.target.value)} 
                placeholder="www.amazon.com" 
              />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="fallback-toggle"
                checked={useLambdaFallback}
                onChange={(e) => update("amazonUseLambdaFallback", String(e.target.checked))}
                className="accent-primary"
              />
              <Label htmlFor="fallback-toggle" className="cursor-pointer font-normal text-muted-foreground">
                Use Legacy Lambda API as fallback if Creators API fails
              </Label>
            </div>
            
            <Button 
              onClick={handleTest} 
              disabled={testing || !clientId || !clientSecret}
              size="sm" 
              variant="outline"
            >
              {testing ? "Testing..." : "Test Creators API"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
