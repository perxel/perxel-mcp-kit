import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

describe("redact", () => {
  const cases: [string, string, string][] = [
    // Emails
    ["Email basic", "Contact me at user@example.com", "Contact me at [email]"],
    ["Email with subdomain", "Email: support@mail.perxel.com", "Email: [email]"],
    ["Email with plus", "My email is user+tag@domain.org", "My email is [email]"],
    ["Multiple emails", "a@b.com and c@d.net", "[email] and [email]"],

    // Vietnamese phone numbers - local format (0 prefix)
    ["Phone local compact", "Call 0901234567", "Call [phone]"],
    ["Phone local spaces", "Call 090 123 4567", "Call [phone]"],
    ["Phone local dots", "Call 090.123.4567", "Call [phone]"],
    ["Phone local dashes", "Call 090-123-4567", "Call [phone]"],
    ["Phone landline spaces", "Office 028 3822 1234", "Office [phone]"],
    ["Phone landline compact", "Office 02838221234", "Office [phone]"],
    ["Phone 11 digits local", "Number 01234567890", "Number [phone]"],
    ["Phone 9 digits local", "Short 091234567", "Short [phone]"],

    // Vietnamese phone numbers - international format (+84)
    ["Phone +84 spaces", "Call +84 90 123 4567", "Call [phone]"],
    ["Phone +84 compact", "Call +84901234567", "Call [phone]"],
    ["Phone +84 dashes", "Call +84-90-123-4567", "Call [phone]"],
    ["Phone +84 dots", "Call +84.90.123.4567", "Call [phone]"],
    ["Phone +84 9 digits after", "Dial +8490123456", "Dial [phone]"],
    ["Phone +84 10 digits after", "Dial +84901234567", "Dial [phone]"],

    // Vietnamese phone numbers - 84 prefix (no +)
    ["Phone 84 compact", "Call 84901234567", "Call [phone]"],
    ["Phone 84 spaces", "Call 84 90 123 4567", "Call [phone]"],
    ["Phone 84 9 digits after", "Dial 8490123456", "Dial [phone]"],

    // Other 9+ digit runs -> [number]
    ["Bank account spaced", "Account 1234 5678 9012", "Account [number]"],
    ["Bank account compact", "Account 123456789012", "Account [number]"],
    ["ID number 12 digits", "CCCD 123456789012", "CCCD [number]"],
    ["ID number 9 digits", "ID 123456789", "ID [number]"],
    ["Long number in sentence", "Ref 9876543210 is yours", "Ref [number] is yours"],
    ["Multiple long numbers", "A 111111111 B 222222222", "A [number] B [number]"],

    // URLs with query strings -> strip query
    ["URL with query", "Visit https://a.com/x?token=1", "Visit https://a.com/x"],
    ["URL with multiple params", "Go to https://site.com/path?a=1&b=2", "Go to https://site.com/path"],
    ["URL with fragment kept", "See https://a.com/x?token=1#section", "See https://a.com/x#section"],
    ["Multiple URLs with queries", "Links: https://a.com/?q=1 and https://b.com/?q=2", "Links: https://a.com/ and https://b.com/"],
    ["URL without query unchanged", "Visit https://a.com/x", "Visit https://a.com/x"],
    ["URL with only fragment", "See https://a.com/x#top", "See https://a.com/x#top"],

    // Combined: email + phone + URL in one text
    ["Combined redact", "Email me@x.com or call 0901234567 or visit https://site.com?ref=abc", "Email [email] or call [phone] or visit https://site.com"],

    // MUST NOT CHANGE - Years
    ["Year 2026", "Year 2026 is coming", "Year 2026 is coming"],
    ["Year in sentence", "In 2025 we launched", "In 2025 we launched"],

    // MUST NOT CHANGE - Prices with dots (VND)
    ["Price VND dots", "Cost 1.500.000đ", "Cost 1.500.000đ"],
    ["Price VND spaced", "Cost 15.000.000 VND", "Cost 15.000.000 VND"],
    ["Price USD comma", "Price $1,200", "Price $1,200"],
    ["Price EUR", "Price €99,99", "Price €99,99"],
    ["Price GBP", "Price £1,200.50", "Price £1,200.50"],

    // MUST NOT CHANGE - Version numbers
    ["Version dots", "Node 16.2.2", "Node 16.2.2"],
    ["Version v prefix", "Release v7.0.116", "Release v7.0.116"],
    ["Version multiple dots", "Lib 1.2.3.4", "Lib 1.2.3.4"],

    // MUST NOT CHANGE - Dates
    ["Date slash", "Date 10/10/2026", "Date 10/10/2026"],
    ["Date dash", "Date 2026-10-10", "Date 2026-10-10"],

    // MUST NOT CHANGE - Times
    ["Time colon", "At 16:01 we start", "At 16:01 we start"],
    ["Time with seconds", "At 16:01:30", "At 16:01:30"],

    // MUST NOT CHANGE - Percentages
    ["Percentage", "Discount 50%", "Discount 50%"],
    ["Percentage decimal", "Rate 3.5%", "Rate 3.5%"],

    // MUST NOT CHANGE - Short numbers
    ["Short number", "Next.js 16 is out", "Next.js 16 is out"],
    ["Small number", "Version 5", "Version 5"],
    ["Order number under 9 digits", "Order 12345678", "Order 12345678"],
    ["Order number 8 digits", "Ref 12345678", "Ref 12345678"],

    // Vietnamese sentences
    ["VN sentence email", "Liên hệ qua email@gmail.com nhé", "Liên hệ qua [email] nhé"],
    ["VN sentence phone", "Gọi 090 123 4567 để tư vấn", "Gọi [phone] để tư vấn"],
    ["VN sentence price", "Giá 1.500.000đ cho gói cơ bản", "Giá 1.500.000đ cho gói cơ bản"],
    ["VN sentence version", "Cập nhật Next.js 16.2.2 hôm nay", "Cập nhật Next.js 16.2.2 hôm nay"],
    ["VN sentence date", "Ngày 10/10/2026 khai giảng", "Ngày 10/10/2026 khai giảng"],

    // English sentences
    ["EN sentence email", "Contact us at hello@perxel.com", "Contact us at [email]"],
    ["EN sentence phone", "Call +84 90 123 4567 for info", "Call [phone] for info"],
    ["EN sentence price", "Price is $1,200 per month", "Price is $1,200 per month"],
    ["EN sentence version", "Using React 18.2.0 now", "Using React 18.2.0 now"],
    ["EN sentence date", "Meeting on 10/10/2026", "Meeting on 10/10/2026"],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  // Additional edge cases
  it("handles empty string", () => {
    expect(redact("")).toBe("");
  });

  it("handles text with no sensitive data", () => {
    expect(redact("Hello world")).toBe("Hello world");
  });

  it("preserves numbers adjacent to letters (like model names)", () => {
    expect(redact("iPhone 15 Pro")).toBe("iPhone 15 Pro");
    expect(redact("Galaxy S24")).toBe("Galaxy S24");
  });

  it("redacts 9-digit number not adjacent to currency/version markers", () => {
    expect(redact("Ref 123456789")).toBe("Ref [number]");
  });

  it("does not over-redact phone-like numbers that are too short", () => {
    expect(redact("Number 09123456")).toBe("Number 09123456"); // 8 digits after 0
  });

  it("redacts over-long phone-like numbers as [number]", () => {
    // 12 digits starting with 0 is not a valid VN phone (max 11), so becomes [number]
    expect(redact("Number 091234567890")).toBe("Number [number]");
  });

  it("handles mixed separators in phone", () => {
    expect(redact("Call 090.123-4567")).toBe("Call [phone]");
    expect(redact("Call +84 90.123-4567")).toBe("Call [phone]");
  });

  it.each([
    ["mã đơn 2026100512", "mã đơn [number]"],
    ["2 000 000 000 đồng", "[number] đồng"],
    ["STK 0123456789 Vietcombank", "STK [phone] Vietcombank"],
    ["CCCD 079201001234", "CCCD [number]"],
    ["Ngân sách 1.500.000.000đ", "Ngân sách 1.500.000.000đ"],
  ])("does not leak part of a longer number: %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
});
