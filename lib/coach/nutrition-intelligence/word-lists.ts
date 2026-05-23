// lib/coach/nutrition-intelligence/word-lists.ts
//
// Token vocabularies for classifying food_log_entries by name.
// Order within each list matters: longer / more-specific tokens come first
// so that `chickpea` is matched before `chick` (which would mis-classify
// to poultry).

export type ProteinCategory =
  | "poultry" | "red_meat" | "fish_seafood" | "eggs"
  | "dairy_protein" | "plant_protein" | "protein_supplement"
  | "mixed" | "unknown";

export type CarbCategory =
  | "whole_grain" | "refined_grain" | "starchy_veg" | "non_starchy_veg"
  | "fruit" | "legume" | "sugar_sweets" | "unknown";

export type CookingMethod =
  | "grilled" | "baked" | "pan_fried" | "deep_fried" | "air_fried"
  | "steamed" | "boiled" | "roasted" | "raw" | "smoked" | "unknown";

/** Tokens checked LEFT-TO-RIGHT — first hit per category wins.
 *  Disambiguators (e.g. `chickpea` before any `chick` test) must come first. */
export const PROTEIN_TOKENS: Array<{ cat: ProteinCategory; tokens: string[] }> = [
  // Disambiguators first — chickpea must lose its "chick" prefix before poultry sees it.
  { cat: "plant_protein", tokens: [
    "chickpea", "chick pea", "garbanzo",
    "tofu", "tempeh", "seitan", "edamame", "soybean", "tvp",
    "lentil", "chana", "moong", "mung",
    "black bean", "kidney bean", "navy bean", "pinto bean", "white bean", "lima bean",
    "hummus", "falafel", "nutritional yeast", "hemp seed", "hemp protein",
  ]},
  { cat: "protein_supplement", tokens: [
    "whey protein", "casein protein", "protein powder", "protein shake",
    "protein bar", "mass gainer", "bcaa",
  ]},
  { cat: "poultry", tokens: [
    "chicken", "turkey", "duck", "hen", "quail", "pheasant", "cornish",
  ]},
  { cat: "red_meat", tokens: [
    "ground beef", "beef", "steak", "ribeye", "sirloin", "tenderloin",
    "filet mignon", "brisket", "chuck", "veal", "lamb", "mutton",
    "venison", "bison", "elk",
    "pork", "ham", "bacon", "sausage", "chorizo", "salami", "prosciutto",
    "pepperoni", "spare rib", "ribs",
  ]},
  { cat: "fish_seafood", tokens: [
    "salmon", "tuna", "cod", "halibut", "mackerel", "sardine", "anchovy",
    "shrimp", "prawn", "lobster", "crab", "oyster", "mussel", "scallop",
    "sole", "tilapia", "trout", "bass", "snapper", "swordfish", "herring",
    "calamari", "squid", "octopus", "clam", "fish",
  ]},
  { cat: "eggs", tokens: [
    "egg white", "egg whites", "scrambled egg", "fried egg", "boiled egg",
    "poached egg", "omelet", "omelette", "frittata", "egg",
  ]},
  { cat: "dairy_protein", tokens: [
    "greek yogurt", "cottage cheese", "ricotta", "kefir", "skyr",
    "milk", "yogurt", "cheese", "feta", "parmesan", "mozzarella",
  ]},
];

export const CARB_TOKENS: Array<{ cat: CarbCategory; tokens: string[] }> = [
  { cat: "whole_grain", tokens: [
    "rolled oats", "steel cut oat", "oatmeal", "oats", "oat",
    "brown rice", "wild rice", "quinoa", "barley", "bulgur", "farro",
    "buckwheat", "millet", "whole wheat", "whole grain", "whole-wheat",
    "spelt", "rye bread", "sourdough whole",
  ]},
  { cat: "refined_grain", tokens: [
    "white rice", "jasmine rice", "basmati rice",
    "pasta", "noodle", "spaghetti", "macaroni", "penne", "fettuccine",
    "bread", "bagel", "baguette", "ciabatta", "tortilla", "wrap",
    "cracker", "pretzel", "cereal", "couscous",
  ]},
  { cat: "starchy_veg", tokens: [
    "sweet potato", "yam", "plantain", "cassava", "yuca",
    "potato", "fries", "mashed potato", "corn", "peas", "pea",
  ]},
  { cat: "fruit", tokens: [
    "apple", "banana", "berry", "berries", "strawberry", "blueberry",
    "raspberry", "blackberry", "grape", "orange", "mango", "peach",
    "pear", "pineapple", "watermelon", "melon", "kiwi", "cherry",
    "plum", "apricot", "papaya", "fig", "date", "raisin",
  ]},
  { cat: "legume", tokens: [
    "lentil", "chickpea", "chick pea", "garbanzo", "chana", "mung", "moong",
    "black bean", "kidney bean", "navy bean", "pinto bean", "white bean",
    "lima bean", "hummus",
  ]},
  { cat: "non_starchy_veg", tokens: [
    "broccoli", "spinach", "kale", "lettuce", "cabbage", "cauliflower",
    "zucchini", "asparagus", "cucumber", "tomato", "pepper", "bell pepper",
    "green bean", "brussels sprout", "arugula", "chard", "collard",
    "bok choy", "celery", "leek", "onion", "garlic", "mushroom",
    "eggplant", "radish", "salad",
  ]},
  { cat: "sugar_sweets", tokens: [
    "candy", "chocolate", "ice cream", "cookie", "cake", "pastry",
    "doughnut", "donut", "soda", "juice", "lemonade", "sweets",
    "honey", "maple syrup", "jam", "jelly",
  ]},
];

export const COOKING_METHOD_TOKENS: Array<{ method: CookingMethod; tokens: string[] }> = [
  { method: "grilled",     tokens: ["grilled", "char-grilled", "chargrilled", "bbq", "barbecue", "barbecued", "charred"] },
  { method: "deep_fried",  tokens: ["deep-fried", "deep fried", "battered", "breaded", "tempura"] },
  { method: "air_fried",   tokens: ["air-fried", "air fried", "air fryer"] },
  { method: "pan_fried",   tokens: ["pan-fried", "pan fried", "stir-fried", "stir fried", "stir-fry", "sauteed", "sautéed", "fried"] },
  { method: "baked",       tokens: ["baked", "oven-baked"] },
  { method: "roasted",     tokens: ["roasted", "roast"] },
  { method: "steamed",     tokens: ["steamed", "steam"] },
  { method: "boiled",      tokens: ["boiled", "poached", "simmered", "braised", "stewed"] },
  { method: "smoked",      tokens: ["smoked"] },
  { method: "raw",         tokens: ["raw", "tartare", "sashimi", "carpaccio", "ceviche"] },
];

/** USDA `foodCategory` → ProteinCategory (high-confidence override).
 *  Source: usda FDC FoodDataCentral category names from cached payloads. */
export const USDA_PROTEIN_CATEGORY: Record<string, ProteinCategory> = {
  "Poultry Products":              "poultry",
  "Beef Products":                 "red_meat",
  "Pork Products":                 "red_meat",
  "Lamb, Veal, and Game Products": "red_meat",
  "Sausages and Luncheon Meats":   "red_meat",
  "Finfish and Shellfish Products":"fish_seafood",
  "Dairy and Egg Products":        "dairy_protein", // post-process eggs subset by name
  "Legumes and Legume Products":   "plant_protein",
};

export const USDA_CARB_CATEGORY: Record<string, CarbCategory> = {
  "Cereal Grains and Pasta":            "refined_grain", // post-process whole-grain subset by name
  "Breakfast Cereals":                  "refined_grain",
  "Baked Products":                     "refined_grain",
  "Vegetables and Vegetable Products":  "non_starchy_veg", // post-process starchy_veg subset by name
  "Fruits and Fruit Juices":            "fruit",
  "Legumes and Legume Products":        "legume",
  "Sweets":                             "sugar_sweets",
  "Beverages":                          "sugar_sweets", // juice/soda dominant
};
