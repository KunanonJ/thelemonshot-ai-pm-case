"""Writes seed/demo-creators.sql: 20 fictional creators with Instagram and TikTok snapshots and two posts each.
Usage: python3 -I seed/gen_demo_seed.py seed/demo-creators.sql
"""
import json
import sys

# id suffix, display name, categories, region, ig handle, tt handle, (ig followers, ig ER %, ig median views),
# (tt followers, tt ER %, tt median views), hashtags
CREATORS = [
    ("01", "Snack Hunter BKK", ["food_snacks"], "Bangkok", "demo_snackhunter.bkk", "demo_snackhunterbkk",
     (48_200, 4.1, 21_000), (182_000, 6.8, 64_000), ["ขนม", "รีวิวขนม", "snack", "snackreview", "อร่อย", "foodbkk"]),
    ("02", "Khanom Diary Mint", ["food_snacks"], "Chiang Mai", "demo_khanomdiary", "demo_khanomdiary.mint",
     (12_400, 6.2, 4_800), (35_600, 9.1, 18_500), ["ขนมไทย", "ของหวาน", "dessert", "homemade", "อร่อย"]),
    ("03", "Street Eats Tong", ["food_snacks"], "Bangkok", "demo_streeteats.tong", "demo_streeteatstong",
     (95_000, 2.4, 30_000), (640_000, 5.2, 210_000), ["streetfood", "อาหาร", "กิน", "ของกิน", "food"]),
    ("04", "Mukbang Ploy", ["food_snacks"], "Bangkok", "demo_mukbangploy", "demo_mukbang.ploy",
     (210_000, 1.9, 52_000), (1_250_000, 4.0, 480_000), ["mukbang", "กิน", "eat", "อร่อย", "yummy"]),
    ("05", "Office Snack Lab", ["food_snacks"], "Bangkok", "demo_officesnacklab", "demo_officesnack.lab",
     (8_900, 7.5, 3_100), (22_000, 11.2, 9_000), ["snack", "officelife", "ขนม", "review"]),
    ("06", "Healthy Bites Fern", ["food_snacks"], "Phuket", "demo_healthybites.fern", "demo_healthybitesfern",
     (76_000, 3.3, 14_000), (58_000, 5.9, 26_000), ["healthysnack", "food", "คลีน", "อาหาร"]),
    ("07", "Sweet Tooth Nam", ["food_snacks"], "Khon Kaen", "demo_sweettooth.nam", "demo_sweettoothnam",
     (155_000, 2.8, 33_000), (310_000, 6.1, 120_000), ["dessert", "ของหวาน", "sweet", "cafe", "yummy"]),
    ("08", "Glow & Snack June", ["food_snacks", "beauty"], "Bangkok", "demo_glowandsnack", "demo_glowsnack.june",
     (132_000, 3.6, 28_000), (98_000, 7.4, 41_000), ["skincare", "snack", "beauty", "ขนม", "lifestyle"]),
    ("09", "Lip & Bite Kwan", ["food_snacks", "beauty"], "Bangkok", "demo_lipandbite.kwan", "demo_lipandbitekwan",
     (41_000, 4.9, 12_500), (120_000, 8.3, 52_000), ["ลิป", "makeup", "food", "รีวิว", "beauty"]),
    ("10", "Skincare Pantry Bee", ["food_snacks", "beauty"], "Chiang Mai", "demo_skincarepantry", "demo_skincarepantry.bee",
     (260_000, 2.2, 47_000), (75_000, 5.0, 30_000), ["สกินแคร์", "skincare", "serum", "ของกิน", "review"]),
    ("11", "Night Market Nok", ["food_snacks"], "Bangkok", "demo_nightmarket.nok", "demo_nightmarketnok",
     (33_500, 3.9, 9_800), (145_000, 6.4, 51_000), ["ตลาดนัด", "ของกิน", "streetfood", "อร่อย"]),
    ("12", "Chip Critic Toon", ["food_snacks"], "Nonthaburi", "demo_chipcritic.toon", "demo_chipcritictoon",
     (22_800, 5.1, 7_400), (88_000, 8.0, 36_000), ["รีวิวขนม", "snackreview", "ขนม", "chips"]),
    ("13", "Family Snack Time Aom", ["food_snacks"], "Chon Buri", "demo_familysnack.aom", "demo_familysnacktime",
     (64_000, 2.9, 15_500), (41_000, 5.5, 17_000), ["ขนมเด็ก", "family", "snack", "อร่อย"]),
    ("14", "Gym and Bites Ice", ["food_snacks"], "Bangkok", "demo_gymbites.ice", "demo_gymandbitesice",
     (51_000, 4.2, 12_000), (72_000, 7.1, 30_000), ["healthysnack", "fitness", "คลีน", "protein"]),
    ("15", "Campus Cravings Beam", ["food_snacks"], "Pathum Thani", "demo_campuscravings", "demo_campuscravings.beam",
     (18_300, 6.6, 6_100), (96_000, 9.4, 44_000), ["studysnack", "ขนม", "campuslife", "yummy"]),
    ("16", "Spicy Stuff Pang", ["food_snacks"], "Udon Thani", "demo_spicystuff.pang", "demo_spicystuffpang",
     (39_000, 3.4, 10_200), (410_000, 5.8, 150_000), ["เผ็ด", "spicy", "ขนม", "challenge"]),
    ("17", "Matcha and Me Fon", ["food_snacks", "beauty"], "Chiang Mai", "demo_matchaandme", "demo_matchaandme.fon",
     (88_000, 3.1, 19_000), (54_000, 6.0, 22_000), ["matcha", "dessert", "skincare", "cafe"]),
    ("18", "Glow Kitchen Mai", ["food_snacks", "beauty"], "Bangkok", "demo_glowkitchen.mai", "demo_glowkitchenmai",
     (120_000, 2.7, 26_000), (66_000, 6.6, 27_000), ["skincare", "ของกิน", "สกินแคร์", "recipe"]),
    ("19", "Weekend Foodie Golf", ["food_snacks"], "Hua Hin", "demo_weekendfoodie", "demo_weekendfoodie.golf",
     (70_500, 3.0, 16_800), (230_000, 5.3, 84_000), ["foodtrip", "อาหาร", "กิน", "weekend"]),
    ("20", "Beauty Bites Lin", ["food_snacks", "beauty"], "Bangkok", "demo_beautybites.lin", "demo_beautybiteslin",
     (47_000, 4.4, 11_500), (138_000, 7.7, 58_000), ["makeup", "snack", "beauty", "ลิป"]),
]

# Two fictional recent posts per creator (Instagram first, TikTok second), so scoring has captions to read
CAPTIONS = {
    "01": ["รีวิวขนมใหม่ 5 ซอง ราคาไม่เกิน 50 บาท อันไหนกรอบสุด? #รีวิวขนม #snackreview", "Blind taste test: 6 chips flavours, ranked by my officemates #snack #ขนม"],
    "02": ["ทำขนมชั้นใบเตยแบบง่ายๆ ใช้ของแค่ 5 อย่าง #ขนมไทย #homemade", "ขนมไทยโบราณ vs ขนมกรุบกรอบยุคใหม่ ชอบแบบไหน? #ของหวาน"],
    "03": ["ตลาดนัดกลางคืน งบ 200 บาท กินได้กี่อย่าง #streetfood #ของกิน", "Night market snack run: 10 stalls in 30 minutes #อาหาร #food"],
    "04": ["Mukbang ขนมกรอบ 20 ซอง เสียงกรอบชัดๆ #mukbang #กิน", "ASMR crunchy snacks, no talking, just crunch #yummy #อร่อย"],
    "05": ["ขนมกินเล่นตอนบ่ายในออฟฟิศ งบ 100 บาทต่อสัปดาห์ #officelife #ขนม", "Rating every snack in our office pantry #snack #review"],
    "06": ["ขนมคลีนแคลต่ำ 5 ตัวที่กินแล้วไม่รู้สึกผิด #healthysnack #คลีน", "Reading snack labels so you don't have to #food #อาหาร"],
    "07": ["คาเฟ่ขนมหวานเปิดใหม่ ขอนแก่น เมนูไหนคุ้มสุด #dessert #ของหวาน", "Sweet vs salty: I let my followers decide my snacks for a day #sweet #yummy"],
    "08": ["Skincare ก่อนนอน แล้วต่อด้วยขนมคืนวันศุกร์ #skincare #ขนม", "Get ready with me + snack haul for movie night #beauty #snack"],
    "09": ["ลิปติดทนแม้กินข้าวมันไก่ ทดสอบจริง #ลิป #makeup", "Does this lip tint survive a bag of spicy chips? #beauty #food"],
    "10": ["เซรั่มที่ใช้อยู่ตอนนี้ กับขนมที่ซ่อนไว้ในโต๊ะเครื่องแป้ง #สกินแคร์ #ของกิน", "Pantry ingredients I'd never put on my face #skincare #review"],
    "11": ["ตลาดนัดกลางคืน งบ 100 บาท ได้ขนมกี่อย่าง #ตลาดนัด #ของกิน", "Night market snack haul, ranked #streetfood #อร่อย"],
    "12": ["รีวิวมันฝรั่งทอด 8 รส ให้คะแนนตรงๆ #รีวิวขนม #chips", "Chip critic: which brand keeps its crunch? #snackreview"],
    "13": ["ขนมกินเล่นกับลูกวันหยุด #ขนมเด็ก #family", "Snacks the whole family agrees on #snack #อร่อย"],
    "14": ["ขนมโปรตีนหลังออกกำลังกาย #healthysnack #protein", "Gym bag snacks under 200 kcal #fitness #คลีน"],
    "15": ["ขนมช่วงอ่านหนังสือสอบ #studysnack #campuslife", "Campus vending machine taste test #ขนม #yummy"],
    "16": ["ท้าเผ็ด! ขนมรสเผ็ดที่สุดในเซเว่น #เผ็ด #challenge", "Spicy chip challenge, round 3 #spicy #ขนม"],
    "17": ["มัทฉะลาเต้กับขนมโฮมเมด #matcha #dessert", "Matcha mask night + matcha snacks #skincare #cafe"],
    "18": ["สูตรขนมจากครัวที่ผิวชอบ #ของกิน #recipe", "Kitchen ingredients in my skincare shelf #skincare #สกินแคร์"],
    "19": ["ทริปกินเที่ยวหัวหินสุดสัปดาห์ #foodtrip #อาหาร", "Weekend road trip snack stops #weekend #กิน"],
    "20": ["ลิปไม่หลุดแม้กินขนมกรอบ #ลิป #makeup", "Snack-proof makeup test #beauty #snack"],
}


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


lines = [
    "-- Demo roster: 20 FICTIONAL creators for showing the suite without Apify. Every name, handle and number",
    "-- is invented; none is a real account. Rows are is_sample = 1 (labelled \"Sample data\" in the app) and",
    "-- source = 'seed', which the enrichment sweep skips because there is nothing to fetch.",
    "--",
    "-- Each creator has two invented posts with real-format URLs: scoring reads the captions, and a campaign can track them.",
    "-- Safe to re-run: creators are inserted once (an admin's curation is kept), and each snapshot's",
    "-- fetched_at and post's posted_at move to now, so shortlists don't flag the data as stale (after 3 days).",
    "-- Apply: pnpm db:seed:demo:remote. To take them out of shortlists without deleting history:",
    "--   UPDATE creators SET active = 0 WHERE source = 'seed';",
    "",
]
# Posts from an earlier version of this seed used another ID scheme; drop them unless a campaign or metric uses them
lines.append("DELETE FROM content_items WHERE id LIKE 'demo-creator-%-post-%' AND id NOT IN (SELECT content_id FROM campaign_posts) "
             "AND id NOT IN (SELECT content_id FROM content_metrics);")
lines.append("")
for sfx, name, cats, region, ig, tt, (igf, iger, igmv), (ttf, tter, ttmv), tags in CREATORS:
    cid = f"demo-creator-{sfx}"
    lines.append(
        "INSERT INTO creators (id, display_name, categories, region, instagram, tiktok, youtube, facebook, past_brands, "
        "collaboration_flags, history_score, history_version, source, is_sample, active, enrichment_status, created_by, "
        f"created_at, updated_at) VALUES ({q(cid)}, {q(name)}, {q(json.dumps(cats))}, {q(region)}, {q(ig)}, {q(tt)}, NULL, NULL, "
        f"'[]', '[]', NULL, NULL, 'seed', 1, 1, 'ok', 'system:demo-seed', unixepoch() * 1000, unixepoch() * 1000) "
        "ON CONFLICT(id) DO NOTHING;"
    )
    for platform, followers, er, mv, following, posts in (("instagram", igf, iger, igmv, 640, 410), ("tiktok", ttf, tter, ttmv, 180, 260)):
        likes = round(followers * er / 100 * 0.96)
        comments = max(3, round(likes * 0.035))
        lines.append(
            "INSERT INTO stat_snapshots (id, creator_id, platform, followers, following, posts_count, engagement_rate, "
            "median_views, avg_likes, avg_comments, recent_posts, top_hashtags, verified, source, source_ref, raw_key, fetched_at) "
            f"VALUES ({q(f'{cid}-{platform}')}, {q(cid)}, {q(platform)}, {followers}, {following}, {posts}, {er}, {mv}, {likes}, "
            f"{comments}, 12, {q(json.dumps(tags, ensure_ascii=False))}, 0, 'apify', 'demo-seed', NULL, unixepoch() * 1000) "
            "ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at;"
        )
    for n, (platform, caption) in enumerate(zip(("instagram", "tiktok"), CAPTIONS[sfx]), start=1):
        row_id = None  # set below: the app's own convention, "<platform>:<post id>" (core/enrichment/service.ts)
        # Real-format URLs, so a planner can paste one into a new campaign and it matches this demo creator
        if platform == "tiktok":
            ext = f"74{int(sfx):02d}{n:02d}0000000000000"
            url = f"https://www.tiktok.com/@{tt}/video/{ext}"
        else:
            ext = f"DEMO{int(sfx):02d}P{n}"
            url = f"https://www.instagram.com/p/{ext}/"
        row_id = f"{platform}:{ext}"
        days = 2 + 3 * n + int(sfx) % 3
        lines.append(
            "INSERT INTO content_items (id, creator_id, platform, platform_post_id, url, posted_at, caption, status, first_seen_at) "
            f"VALUES ({q(row_id)}, {q(cid)}, {q(platform)}, {q(ext)}, {q(url)}, unixepoch() * 1000 - {days} * 86400000, {q(caption)}, "
            "'available', unixepoch() * 1000) ON CONFLICT(id) DO UPDATE SET platform_post_id = excluded.platform_post_id, url = excluded.url, posted_at = excluded.posted_at;"
        )
    lines.append("")

open(sys.argv[1], "w", encoding="utf-8").write("\n".join(lines))
print(f"wrote {len(CREATORS)} creators, {2 * len(CREATORS)} snapshots, {2 * len(CREATORS)} posts")
