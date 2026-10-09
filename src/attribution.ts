const creators = [
  { id: "crt_ana", coupon: "ANA10", utm_content: "ana" },
  { id: "crt_bruno", coupon: "BRUNO10", utm_content: "bruno" },
];

export function attributeSale(coupon: string | null, utmContent: string | null) {
  const byCoupon = creators.find((creator) => creator.coupon === coupon);
  if (byCoupon) return { creator_id: byCoupon.id, attribution_source: "coupon" as const };

  const byUtm = creators.find((creator) => creator.utm_content === utmContent);
  if (byUtm) return { creator_id: byUtm.id, attribution_source: "utm" as const };

  return { creator_id: null, attribution_source: null };
}
