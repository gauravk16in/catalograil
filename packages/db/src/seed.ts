/**
 * Seeds three merchants across three verticals with ~60 products (T1.5).
 *
 *   DATABASE_URL=postgres://... pnpm db:seed
 *
 * The verticals are deliberately different in shape, because they exercise different
 * parts of the pipeline: electronics is flat SIMPLE, apparel is multi-axis VARIANT
 * that expands into many searchable units, and home services is SIMPLE with no
 * shipping weight and a delivery time that means "appointment lead time".
 *
 * Idempotent: fixed UUIDs and `external_ref`s, so re-running updates rather than
 * duplicates — the same property T1.11 requires of a re-uploaded CSV.
 *
 * `searchable_units` is deliberately NOT seeded. Only the embedding worker writes
 * there (never-do #2); seeding it by hand would paper over a broken pipeline.
 */
import { rupeeStringToPaise } from '@catalograil/core';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  categories,
  merchantCapabilities,
  merchantMetrics,
  merchantPolicies,
  merchants,
  productOptionAxes,
  productVariants,
  products,
} from './schema/index.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client);

// Fixed IDs keep the seed idempotent and make test fixtures quotable.
const MERCHANT_ELECTRONICS = '11111111-1111-4111-8111-111111111111';
const MERCHANT_APPAREL = '22222222-2222-4222-8222-222222222222';
const MERCHANT_SERVICES = '33333333-3333-4333-8333-333333333333';

interface CategorySeed {
  id: string;
  slug: string;
  name: string;
  path: string;
  parent?: string;
}

const CATEGORIES: CategorySeed[] = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    slug: 'electronics',
    name: 'Electronics',
    path: 'electronics',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    slug: 'car-accessories',
    name: 'Car Accessories',
    path: 'electronics.car_accessories',
    parent: 'c0000000-0000-4000-8000-000000000001',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    slug: 'audio',
    name: 'Audio',
    path: 'electronics.audio',
    parent: 'c0000000-0000-4000-8000-000000000001',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004',
    slug: 'charging',
    name: 'Charging & Power',
    path: 'electronics.charging',
    parent: 'c0000000-0000-4000-8000-000000000001',
  },
  { id: 'c0000000-0000-4000-8000-000000000010', slug: 'apparel', name: 'Apparel', path: 'apparel' },
  {
    id: 'c0000000-0000-4000-8000-000000000011',
    slug: 'shirts',
    name: 'Shirts',
    path: 'apparel.shirts',
    parent: 'c0000000-0000-4000-8000-000000000010',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000012',
    slug: 'kurtas',
    name: 'Kurtas',
    path: 'apparel.kurtas',
    parent: 'c0000000-0000-4000-8000-000000000010',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000013',
    slug: 'trousers',
    name: 'Trousers',
    path: 'apparel.trousers',
    parent: 'c0000000-0000-4000-8000-000000000010',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000020',
    slug: 'home-services',
    name: 'Home Services',
    path: 'services.home',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000021',
    slug: 'appliance-service',
    name: 'Appliance Service',
    path: 'services.home.appliance',
    parent: 'c0000000-0000-4000-8000-000000000020',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000022',
    slug: 'cleaning',
    name: 'Cleaning',
    path: 'services.home.cleaning',
    parent: 'c0000000-0000-4000-8000-000000000020',
  },
];

const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.slug, c.id])) as Record<string, string>;

interface SimpleSeed {
  ref: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  price: string;
  mrp: string;
  stock: number;
  deliveryDays: number;
  weightGrams?: number;
  attributes: Record<string, unknown>;
}

const ELECTRONICS: SimpleSeed[] = [
  {
    ref: 'EL-DASH-001',
    name: 'RoadEye 4K Dashcam',
    brand: 'RoadEye',
    description:
      'Front-facing 4K dashcam with 170° wide angle, night mode and loop recording. Parking surveillance with G-sensor impact detection.',
    category: 'car-accessories',
    price: '8499',
    mrp: '10999',
    stock: 42,
    deliveryDays: 3,
    weightGrams: 210,
    attributes: {
      resolution: '4K',
      field_of_view_degrees: 170,
      night_mode: true,
      storage: 'microSD up to 256GB',
    },
  },
  {
    ref: 'EL-DASH-002',
    name: 'RoadEye Dual-Channel Dashcam',
    brand: 'RoadEye',
    description:
      'Records road ahead and cabin simultaneously. Popular with cab drivers for passenger dispute evidence.',
    category: 'car-accessories',
    price: '12499',
    mrp: '15999',
    stock: 18,
    deliveryDays: 3,
    weightGrams: 320,
    attributes: { resolution: '1440p+1080p', channels: 2, night_mode: true, gps: true },
  },
  {
    ref: 'EL-DASH-003',
    name: 'RoadEye Mini Dashcam',
    brand: 'RoadEye',
    description:
      'Compact 1080p dashcam that hides behind the rear-view mirror. No screen, configured over Wi-Fi.',
    category: 'car-accessories',
    price: '3999',
    mrp: '5499',
    stock: 90,
    deliveryDays: 2,
    weightGrams: 95,
    attributes: { resolution: '1080p', wifi: true, screen: false },
  },
  {
    ref: 'EL-CHRG-001',
    name: 'VoltCore 65W GaN Charger',
    brand: 'VoltCore',
    description:
      'Three-port GaN charger, 65W total. Charges a laptop and two phones at once. Fits an Indian two-pin socket without an adapter.',
    category: 'charging',
    price: '2799',
    mrp: '3999',
    stock: 150,
    deliveryDays: 2,
    weightGrams: 120,
    attributes: { wattage: 65, ports: 3, technology: 'GaN', pd: true },
  },
  {
    ref: 'EL-CHRG-002',
    name: 'VoltCore 30W Compact Charger',
    brand: 'VoltCore',
    description: 'Single USB-C port, palm sized. The one to keep in a laptop bag as a spare.',
    category: 'charging',
    price: '1299',
    mrp: '1799',
    stock: 220,
    deliveryDays: 2,
    weightGrams: 58,
    attributes: { wattage: 30, ports: 1, technology: 'GaN', pd: true },
  },
  {
    ref: 'EL-CHRG-003',
    name: 'VoltCore 20000mAh Power Bank',
    brand: 'VoltCore',
    description:
      '20000mAh power bank with 22.5W fast charging and a built-in USB-C cable. Airline cabin approved.',
    category: 'charging',
    price: '2499',
    mrp: '3499',
    stock: 76,
    deliveryDays: 3,
    weightGrams: 410,
    attributes: { capacity_mah: 20000, wattage: 22.5, built_in_cable: true },
  },
  {
    ref: 'EL-CHRG-004',
    name: 'VoltCore Wireless Car Mount',
    brand: 'VoltCore',
    description:
      '15W Qi wireless charging phone mount with auto-clamping arms. Vent and dashboard fittings included.',
    category: 'car-accessories',
    price: '1899',
    mrp: '2699',
    stock: 64,
    deliveryDays: 2,
    weightGrams: 180,
    attributes: { wattage: 15, wireless: true, mount_type: 'vent+dashboard' },
  },
  {
    ref: 'EL-AUD-001',
    name: 'Sonrise Studio 40 Headphones',
    brand: 'Sonrise',
    description:
      'Over-ear active noise cancelling headphones, 40 hour battery. Foldable with a hard travel case.',
    category: 'audio',
    price: '7999',
    mrp: '11999',
    stock: 33,
    deliveryDays: 4,
    weightGrams: 290,
    attributes: { type: 'over-ear', anc: true, battery_hours: 40, foldable: true },
  },
  {
    ref: 'EL-AUD-002',
    name: 'Sonrise Buds Pro',
    brand: 'Sonrise',
    description:
      'True wireless earbuds with adaptive noise cancellation and IPX5 sweat resistance. Six hours per charge.',
    category: 'audio',
    price: '4499',
    mrp: '6999',
    stock: 110,
    deliveryDays: 2,
    weightGrams: 48,
    attributes: { type: 'in-ear', anc: true, battery_hours: 6, water_resistance: 'IPX5' },
  },
  {
    ref: 'EL-AUD-003',
    name: 'Sonrise Buds Lite',
    brand: 'Sonrise',
    description:
      'Entry-level true wireless earbuds. No ANC, but 8 hours of playback and a very small case.',
    category: 'audio',
    price: '1799',
    mrp: '2999',
    stock: 240,
    deliveryDays: 2,
    weightGrams: 42,
    attributes: { type: 'in-ear', anc: false, battery_hours: 8, water_resistance: 'IPX4' },
  },
  {
    ref: 'EL-AUD-004',
    name: 'Sonrise Boom 20 Speaker',
    brand: 'Sonrise',
    description:
      '20W portable Bluetooth speaker, IP67 rated. Floats in water and survives a beach trip.',
    category: 'audio',
    price: '3299',
    mrp: '4999',
    stock: 55,
    deliveryDays: 3,
    weightGrams: 620,
    attributes: { wattage: 20, water_resistance: 'IP67', battery_hours: 14, floats: true },
  },
  {
    ref: 'EL-AUD-005',
    name: 'Sonrise Soundbar 120',
    brand: 'Sonrise',
    description: '120W 2.1 channel soundbar with a wireless subwoofer. HDMI ARC and optical input.',
    category: 'audio',
    price: '9999',
    mrp: '14999',
    stock: 21,
    deliveryDays: 5,
    weightGrams: 3400,
    attributes: { wattage: 120, channels: '2.1', hdmi_arc: true, subwoofer: 'wireless' },
  },
  {
    ref: 'EL-CAR-001',
    name: 'RoadEye Tyre Inflator',
    brand: 'RoadEye',
    description:
      'Digital tyre inflator with preset pressure cut-off. Runs off the 12V socket, inflates a car tyre in about three minutes.',
    category: 'car-accessories',
    price: '2199',
    mrp: '3299',
    stock: 88,
    deliveryDays: 3,
    weightGrams: 1100,
    attributes: { max_psi: 150, power: '12V', auto_cutoff: true },
  },
  {
    ref: 'EL-CAR-002',
    name: 'RoadEye Jump Starter 1200A',
    brand: 'RoadEye',
    description:
      '1200A peak jump starter that also works as a power bank and an LED work light. Starts a petrol car up to 6L.',
    category: 'car-accessories',
    price: '5499',
    mrp: '7999',
    stock: 29,
    deliveryDays: 4,
    weightGrams: 780,
    attributes: { peak_amps: 1200, capacity_mah: 18000, led_light: true },
  },
  {
    ref: 'EL-CAR-003',
    name: 'RoadEye Car Vacuum',
    brand: 'RoadEye',
    description:
      'Handheld 12V car vacuum with a HEPA filter and three nozzles. Five metre cord reaches the boot.',
    category: 'car-accessories',
    price: '1699',
    mrp: '2499',
    stock: 130,
    deliveryDays: 2,
    weightGrams: 900,
    attributes: { power: '12V', filter: 'HEPA', cord_metres: 5 },
  },
  {
    ref: 'EL-CAR-004',
    name: 'RoadEye Seat Organiser',
    brand: 'RoadEye',
    description:
      'Back-seat organiser in water-resistant fabric with a tablet holder and insulated bottle pockets.',
    category: 'car-accessories',
    price: '899',
    mrp: '1499',
    stock: 175,
    deliveryDays: 2,
    weightGrams: 480,
    attributes: { material: 'polyester', tablet_holder: true, insulated_pockets: 2 },
  },
  {
    ref: 'EL-CHRG-005',
    name: 'VoltCore 100W USB-C Cable 2m',
    brand: 'VoltCore',
    description:
      'Braided 100W USB-C to USB-C cable, two metres. Carries 4K video as well as power.',
    category: 'charging',
    price: '699',
    mrp: '1199',
    stock: 400,
    deliveryDays: 2,
    weightGrams: 90,
    attributes: { wattage: 100, length_metres: 2, braided: true, video: '4K' },
  },
  {
    ref: 'EL-CHRG-006',
    name: 'VoltCore Magnetic Charging Stand',
    brand: 'VoltCore',
    description:
      'MagSafe compatible 15W charging stand with an adjustable angle. Works in landscape for video calls.',
    category: 'charging',
    price: '2299',
    mrp: '3299',
    stock: 61,
    deliveryDays: 3,
    weightGrams: 260,
    attributes: { wattage: 15, magnetic: true, adjustable: true },
  },
  {
    ref: 'EL-AUD-006',
    name: 'Sonrise Podcast Mic USB',
    brand: 'Sonrise',
    description:
      'Cardioid USB condenser microphone with a desk stand and a built-in headphone monitor jack.',
    category: 'audio',
    price: '4999',
    mrp: '7499',
    stock: 24,
    deliveryDays: 4,
    weightGrams: 850,
    attributes: { pattern: 'cardioid', connection: 'USB-C', monitoring: true },
  },
  {
    ref: 'EL-AUD-007',
    name: 'Sonrise Turntable Belt Drive',
    brand: 'Sonrise',
    description:
      'Belt-drive turntable with a built-in phono preamp and Bluetooth output. Ships with a pre-mounted cartridge.',
    category: 'audio',
    price: '13999',
    mrp: '18999',
    stock: 8,
    deliveryDays: 6,
    weightGrams: 4200,
    attributes: { drive: 'belt', preamp: true, bluetooth: true },
  },
  {
    ref: 'EL-DASH-004',
    name: 'RoadEye Rear Camera Add-on',
    brand: 'RoadEye',
    description:
      'Rear camera module for the RoadEye 4K and Dual-Channel dashcams. Six metre cable included.',
    category: 'car-accessories',
    price: '2499',
    mrp: '3499',
    stock: 47,
    deliveryDays: 3,
    weightGrams: 140,
    attributes: {
      resolution: '1080p',
      cable_metres: 6,
      compatible_with: 'EL-DASH-001, EL-DASH-002',
    },
  },
  {
    ref: 'EL-CHRG-007',
    name: 'VoltCore Solar Panel 60W',
    brand: 'VoltCore',
    description:
      'Foldable 60W solar panel for camping. Two USB outputs and a DC barrel for portable power stations.',
    category: 'charging',
    price: '6999',
    mrp: '9999',
    stock: 15,
    deliveryDays: 6,
    weightGrams: 2600,
    attributes: { wattage: 60, foldable: true, outputs: 'USB-A, USB-C, DC' },
  },
  {
    ref: 'EL-AUD-008',
    name: 'Sonrise Bookshelf Speakers Pair',
    brand: 'Sonrise',
    description:
      'Passive two-way bookshelf speakers, 5.25 inch woofer. Real wood veneer cabinets, sold as a pair.',
    category: 'audio',
    price: '11499',
    mrp: '15999',
    stock: 12,
    deliveryDays: 7,
    weightGrams: 7800,
    attributes: { type: 'passive', woofer_inches: 5.25, sold_as: 'pair' },
  },
  {
    ref: 'EL-CAR-005',
    name: 'RoadEye OBD-II Scanner',
    brand: 'RoadEye',
    description:
      'Bluetooth OBD-II scanner that reads and clears engine fault codes from a phone app. Works on petrol cars from 2010 onward.',
    category: 'car-accessories',
    price: '1499',
    mrp: '2299',
    stock: 95,
    deliveryDays: 2,
    weightGrams: 60,
    attributes: { connection: 'Bluetooth', clears_codes: true, min_model_year: 2010 },
  },
];

const SERVICES: SimpleSeed[] = [
  {
    ref: 'SV-AC-001',
    name: 'Split AC Deep Service',
    brand: 'Sabki Seva',
    description:
      'Full split AC service: coil cleaning with a jet pump, drain flush, gas pressure check and filter wash. One indoor unit.',
    category: 'appliance-service',
    price: '699',
    mrp: '899',
    stock: 999,
    deliveryDays: 1,
    attributes: { unit_type: 'split', duration_minutes: 60, technicians: 1, warranty_days: 30 },
  },
  {
    ref: 'SV-AC-002',
    name: 'Window AC Service',
    brand: 'Sabki Seva',
    description: 'Window AC service including chassis removal, coil wash and cooling check.',
    category: 'appliance-service',
    price: '599',
    mrp: '799',
    stock: 999,
    deliveryDays: 1,
    attributes: { unit_type: 'window', duration_minutes: 45, technicians: 1, warranty_days: 30 },
  },
  {
    ref: 'SV-AC-003',
    name: 'AC Gas Refill R32',
    brand: 'Sabki Seva',
    description:
      'R32 refrigerant top-up with leak testing. Price covers up to 1.5 ton; larger units quoted on site.',
    category: 'appliance-service',
    price: '2499',
    mrp: '2999',
    stock: 999,
    deliveryDays: 1,
    attributes: { refrigerant: 'R32', max_tonnage: 1.5, leak_test: true, warranty_days: 90 },
  },
  {
    ref: 'SV-AC-004',
    name: 'AC Installation Split',
    brand: 'Sabki Seva',
    description:
      'Split AC installation with up to 3 metres of copper piping, wall bracket and drainage. Core cutting charged separately.',
    category: 'appliance-service',
    price: '1799',
    mrp: '2199',
    stock: 999,
    deliveryDays: 2,
    attributes: { piping_metres: 3, bracket_included: true, duration_minutes: 120 },
  },
  {
    ref: 'SV-AC-005',
    name: 'AC Uninstallation',
    brand: 'Sabki Seva',
    description:
      'Safe removal of a split AC with gas recovery, so the unit can be reinstalled elsewhere.',
    category: 'appliance-service',
    price: '899',
    mrp: '1199',
    stock: 999,
    deliveryDays: 1,
    attributes: { gas_recovery: true, duration_minutes: 60 },
  },
  {
    ref: 'SV-APP-001',
    name: 'Washing Machine Service Front Load',
    brand: 'Sabki Seva',
    description:
      'Front load washing machine service: drum clean, filter clear, drain check and level adjustment.',
    category: 'appliance-service',
    price: '649',
    mrp: '849',
    stock: 999,
    deliveryDays: 1,
    attributes: { appliance: 'washing_machine', load_type: 'front', duration_minutes: 50 },
  },
  {
    ref: 'SV-APP-002',
    name: 'Washing Machine Service Top Load',
    brand: 'Sabki Seva',
    description: 'Top load washing machine service with pulsator clean and inlet valve check.',
    category: 'appliance-service',
    price: '549',
    mrp: '749',
    stock: 999,
    deliveryDays: 1,
    attributes: { appliance: 'washing_machine', load_type: 'top', duration_minutes: 45 },
  },
  {
    ref: 'SV-APP-003',
    name: 'Refrigerator Service Double Door',
    brand: 'Sabki Seva',
    description:
      'Double door fridge service: condenser clean, defrost check, door gasket inspection and thermostat test.',
    category: 'appliance-service',
    price: '699',
    mrp: '899',
    stock: 999,
    deliveryDays: 1,
    attributes: { appliance: 'refrigerator', doors: 2, duration_minutes: 50 },
  },
  {
    ref: 'SV-APP-004',
    name: 'Microwave Repair Visit',
    brand: 'Sabki Seva',
    description:
      'Diagnostic visit for a microwave that will not heat. Visit fee is adjusted against the repair if you proceed.',
    category: 'appliance-service',
    price: '399',
    mrp: '499',
    stock: 999,
    deliveryDays: 1,
    attributes: { appliance: 'microwave', diagnostic_only: true, fee_adjustable: true },
  },
  {
    ref: 'SV-APP-005',
    name: 'Chimney Deep Clean',
    brand: 'Sabki Seva',
    description:
      'Kitchen chimney degreasing including baffle filters, oil collector and motor housing.',
    category: 'appliance-service',
    price: '1099',
    mrp: '1499',
    stock: 999,
    deliveryDays: 2,
    attributes: { appliance: 'chimney', duration_minutes: 90, degreasing: true },
  },
  {
    ref: 'SV-APP-006',
    name: 'Geyser Service',
    brand: 'Sabki Seva',
    description:
      'Water heater descaling, element check and thermostat calibration for storage geysers up to 25L.',
    category: 'appliance-service',
    price: '599',
    mrp: '799',
    stock: 999,
    deliveryDays: 1,
    attributes: { appliance: 'geyser', max_litres: 25, descaling: true },
  },
  {
    ref: 'SV-CLN-001',
    name: 'Full Home Deep Cleaning 2BHK',
    brand: 'Sabki Seva',
    description:
      'Whole-house deep clean for a 2BHK: bathrooms, kitchen degreasing, floor scrubbing, fan and window cleaning. Team of three, about five hours.',
    category: 'cleaning',
    price: '4499',
    mrp: '5999',
    stock: 999,
    deliveryDays: 2,
    attributes: {
      home_size: '2BHK',
      technicians: 3,
      duration_minutes: 300,
      includes_kitchen: true,
    },
  },
  {
    ref: 'SV-CLN-002',
    name: 'Full Home Deep Cleaning 3BHK',
    brand: 'Sabki Seva',
    description: 'Whole-house deep clean for a 3BHK. Team of four, about seven hours.',
    category: 'cleaning',
    price: '6499',
    mrp: '8499',
    stock: 999,
    deliveryDays: 2,
    attributes: {
      home_size: '3BHK',
      technicians: 4,
      duration_minutes: 420,
      includes_kitchen: true,
    },
  },
  {
    ref: 'SV-CLN-003',
    name: 'Bathroom Deep Clean',
    brand: 'Sabki Seva',
    description: 'Single bathroom deep clean with hard water stain removal and grout scrubbing.',
    category: 'cleaning',
    price: '699',
    mrp: '999',
    stock: 999,
    deliveryDays: 1,
    attributes: { rooms: 1, hard_water_treatment: true, duration_minutes: 75 },
  },
  {
    ref: 'SV-CLN-004',
    name: 'Sofa Shampooing 5 Seater',
    brand: 'Sabki Seva',
    description:
      'Wet shampooing and vacuum extraction for a five seater fabric sofa. Dries in about four hours.',
    category: 'cleaning',
    price: '1299',
    mrp: '1799',
    stock: 999,
    deliveryDays: 1,
    attributes: { seats: 5, method: 'wet_shampoo', dry_hours: 4 },
  },
  {
    ref: 'SV-CLN-005',
    name: 'Mattress Cleaning Queen',
    brand: 'Sabki Seva',
    description:
      'Queen mattress vacuum, UV treatment and stain spotting. No water used, so it is usable the same night.',
    category: 'cleaning',
    price: '899',
    mrp: '1299',
    stock: 999,
    deliveryDays: 1,
    attributes: { size: 'queen', method: 'dry_uv', same_day_use: true },
  },
  {
    ref: 'SV-CLN-006',
    name: 'Pest Control General Disinfection',
    brand: 'Sabki Seva',
    description:
      'General pest treatment for cockroaches and ants across a 2BHK. Odourless, child and pet safe after two hours.',
    category: 'cleaning',
    price: '1499',
    mrp: '1999',
    stock: 999,
    deliveryDays: 2,
    attributes: {
      home_size: '2BHK',
      targets: 'cockroach, ant',
      pet_safe_after_hours: 2,
      warranty_days: 90,
    },
  },
  {
    ref: 'SV-CLN-007',
    name: 'Water Tank Cleaning 1000L',
    brand: 'Sabki Seva',
    description:
      'Overhead tank drain, scrub, vacuum and chlorine disinfection for tanks up to 1000 litres.',
    category: 'cleaning',
    price: '1199',
    mrp: '1599',
    stock: 999,
    deliveryDays: 2,
    attributes: { max_litres: 1000, disinfection: 'chlorine', duration_minutes: 90 },
  },
];

interface VariantSeed {
  ref: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  axes: { name: string; values: string[] }[];
  basePrice: string;
  mrp: string;
  deliveryDays: number;
  weightGrams: number;
  attributes: Record<string, unknown>;
}

const APPAREL: VariantSeed[] = [
  {
    ref: 'AP-SHIRT-001',
    name: 'Meridian Oxford Shirt',
    brand: 'Meridian',
    description:
      'Long sleeve oxford cotton shirt with a button-down collar. Regular fit, machine washable, does not need ironing after a line dry.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['38', '40', '42', '44'] },
      { name: 'colour', values: ['white', 'sky', 'lilac'] },
    ],
    basePrice: '1899',
    mrp: '2799',
    deliveryDays: 3,
    weightGrams: 280,
    attributes: { fabric: 'cotton', fit: 'regular', sleeve: 'long', collar: 'button-down' },
  },
  {
    ref: 'AP-SHIRT-002',
    name: 'Meridian Linen Shirt',
    brand: 'Meridian',
    description:
      'Pure linen half sleeve shirt. Breathes well through a Chennai summer, creases the way linen is supposed to.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['38', '40', '42', '44'] },
      { name: 'colour', values: ['sand', 'olive', 'white'] },
    ],
    basePrice: '2299',
    mrp: '3299',
    deliveryDays: 4,
    weightGrams: 210,
    attributes: { fabric: 'linen', fit: 'relaxed', sleeve: 'half' },
  },
  {
    ref: 'AP-SHIRT-003',
    name: 'Meridian Formal Twill Shirt',
    brand: 'Meridian',
    description:
      'Wrinkle-resistant twill formal shirt with a spread collar. Slim fit, suited to an office with a strict dress code.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['38', '40', '42', '44', '46'] },
      { name: 'colour', values: ['white', 'black', 'navy'] },
    ],
    basePrice: '1699',
    mrp: '2499',
    deliveryDays: 3,
    weightGrams: 260,
    attributes: { fabric: 'cotton-twill', fit: 'slim', sleeve: 'long', wrinkle_resistant: true },
  },
  {
    ref: 'AP-SHIRT-004',
    name: 'Meridian Checked Flannel Shirt',
    brand: 'Meridian',
    description:
      'Brushed cotton flannel in a windowpane check. Warm enough for a Bengaluru December evening.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['40', '42', '44'] },
      { name: 'colour', values: ['rust', 'forest'] },
    ],
    basePrice: '2099',
    mrp: '2999',
    deliveryDays: 4,
    weightGrams: 340,
    attributes: { fabric: 'flannel', fit: 'regular', sleeve: 'long', pattern: 'check' },
  },
  {
    ref: 'AP-SHIRT-005',
    name: 'Meridian Denim Shirt',
    brand: 'Meridian',
    description: 'Lightweight 6oz denim shirt with metal press studs. Wears in rather than out.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['38', '40', '42', '44'] },
      { name: 'colour', values: ['indigo', 'washed-blue'] },
    ],
    basePrice: '2499',
    mrp: '3499',
    deliveryDays: 4,
    weightGrams: 400,
    attributes: { fabric: 'denim', weight_oz: 6, fit: 'regular', closure: 'press-stud' },
  },
  {
    ref: 'AP-KURTA-001',
    name: 'Aangan Cotton Kurta',
    brand: 'Aangan',
    description:
      'Straight cut cotton kurta with side slits and a mandarin collar. Everyday wear, holds colour through repeated washes.',
    category: 'kurtas',
    axes: [
      { name: 'size', values: ['S', 'M', 'L', 'XL', 'XXL'] },
      { name: 'colour', values: ['white', 'indigo', 'maroon'] },
    ],
    basePrice: '1299',
    mrp: '1899',
    deliveryDays: 3,
    weightGrams: 300,
    attributes: { fabric: 'cotton', fit: 'straight', collar: 'mandarin', occasion: 'daily' },
  },
  {
    ref: 'AP-KURTA-002',
    name: 'Aangan Silk Blend Festive Kurta',
    brand: 'Aangan',
    description:
      'Silk blend kurta with subtle self-weave and a matching churidar. Cut for weddings and festival evenings.',
    category: 'kurtas',
    axes: [
      { name: 'size', values: ['S', 'M', 'L', 'XL'] },
      { name: 'colour', values: ['gold', 'wine', 'ivory'] },
    ],
    basePrice: '3499',
    mrp: '4999',
    deliveryDays: 5,
    weightGrams: 420,
    attributes: {
      fabric: 'silk-blend',
      fit: 'straight',
      includes: 'churidar',
      occasion: 'festive',
    },
  },
  {
    ref: 'AP-KURTA-003',
    name: 'Aangan Khadi Kurta',
    brand: 'Aangan',
    description:
      'Handspun khadi kurta, unbleached. Softens with every wash; expect a slight shrink on the first one.',
    category: 'kurtas',
    axes: [
      { name: 'size', values: ['M', 'L', 'XL'] },
      { name: 'colour', values: ['natural', 'charcoal'] },
    ],
    basePrice: '1799',
    mrp: '2499',
    deliveryDays: 4,
    weightGrams: 330,
    attributes: { fabric: 'khadi', handspun: true, fit: 'relaxed' },
  },
  {
    ref: 'AP-KURTA-004',
    name: 'Aangan Short Kurta',
    brand: 'Aangan',
    description: 'Hip-length short kurta in cotton slub, meant to be worn with jeans.',
    category: 'kurtas',
    axes: [
      { name: 'size', values: ['S', 'M', 'L', 'XL'] },
      { name: 'colour', values: ['sage', 'black', 'rust'] },
    ],
    basePrice: '1099',
    mrp: '1599',
    deliveryDays: 3,
    weightGrams: 250,
    attributes: { fabric: 'cotton-slub', length: 'hip', fit: 'slim' },
  },
  {
    ref: 'AP-TRSR-001',
    name: 'Meridian Chino Trousers',
    brand: 'Meridian',
    description:
      'Mid-rise stretch cotton chinos with a clean finish. Holds a crease without being formal.',
    category: 'trousers',
    axes: [
      { name: 'waist', values: ['30', '32', '34', '36', '38'] },
      { name: 'colour', values: ['khaki', 'navy', 'olive'] },
    ],
    basePrice: '2199',
    mrp: '3199',
    deliveryDays: 3,
    weightGrams: 460,
    attributes: { fabric: 'cotton-stretch', rise: 'mid', fit: 'slim' },
  },
  {
    ref: 'AP-TRSR-002',
    name: 'Meridian Linen Drawstring Trousers',
    brand: 'Meridian',
    description: 'Elasticated linen trousers with a drawstring waist. The ones to travel in.',
    category: 'trousers',
    axes: [
      { name: 'size', values: ['S', 'M', 'L', 'XL'] },
      { name: 'colour', values: ['sand', 'white'] },
    ],
    basePrice: '1899',
    mrp: '2699',
    deliveryDays: 4,
    weightGrams: 340,
    attributes: { fabric: 'linen', waist: 'drawstring', fit: 'relaxed' },
  },
  {
    ref: 'AP-TRSR-003',
    name: 'Meridian Formal Trousers',
    brand: 'Meridian',
    description:
      'Flat front poly-viscose formal trousers with a hidden hook closure. Machine washable, unlike most suiting.',
    category: 'trousers',
    axes: [
      { name: 'waist', values: ['30', '32', '34', '36', '38', '40'] },
      { name: 'colour', values: ['black', 'charcoal', 'navy'] },
    ],
    basePrice: '1999',
    mrp: '2899',
    deliveryDays: 3,
    weightGrams: 480,
    attributes: { fabric: 'poly-viscose', front: 'flat', fit: 'regular', machine_washable: true },
  },
  {
    ref: 'AP-TRSR-004',
    name: 'Meridian Cargo Trousers',
    brand: 'Meridian',
    description:
      'Six-pocket ripstop cargo trousers with a tapered leg. Pockets sized for a phone and a passport.',
    category: 'trousers',
    axes: [
      { name: 'waist', values: ['30', '32', '34', '36'] },
      { name: 'colour', values: ['olive', 'black'] },
    ],
    basePrice: '2599',
    mrp: '3699',
    deliveryDays: 4,
    weightGrams: 620,
    attributes: { fabric: 'ripstop', pockets: 6, fit: 'tapered' },
  },
  {
    ref: 'AP-SHIRT-006',
    name: 'Meridian Mandarin Collar Shirt',
    brand: 'Meridian',
    description:
      'Collarless cotton shirt with a placket that stops halfway. Works under a Nehru jacket.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['38', '40', '42', '44'] },
      { name: 'colour', values: ['white', 'black', 'sage'] },
    ],
    basePrice: '1799',
    mrp: '2599',
    deliveryDays: 3,
    weightGrams: 270,
    attributes: { fabric: 'cotton', collar: 'mandarin', fit: 'regular' },
  },
  {
    ref: 'AP-SHIRT-007',
    name: 'Meridian Printed Resort Shirt',
    brand: 'Meridian',
    description:
      'Camp collar viscose shirt in a botanical print. Cut boxy, meant to be worn untucked.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['M', 'L', 'XL'] },
      { name: 'colour', values: ['palm', 'terracotta'] },
    ],
    basePrice: '1599',
    mrp: '2299',
    deliveryDays: 3,
    weightGrams: 220,
    attributes: { fabric: 'viscose', collar: 'camp', fit: 'boxy', pattern: 'botanical' },
  },
  {
    ref: 'AP-KURTA-005',
    name: 'Aangan Chikankari Kurta',
    brand: 'Aangan',
    description:
      'Hand-embroidered Lucknowi chikankari on cotton mul. Each piece varies slightly, which is the point.',
    category: 'kurtas',
    axes: [
      { name: 'size', values: ['S', 'M', 'L', 'XL'] },
      { name: 'colour', values: ['white', 'powder-blue'] },
    ],
    basePrice: '2899',
    mrp: '3999',
    deliveryDays: 6,
    weightGrams: 240,
    attributes: {
      fabric: 'cotton-mul',
      embroidery: 'chikankari',
      handmade: true,
      occasion: 'festive',
    },
  },
  {
    ref: 'AP-TRSR-005',
    name: 'Meridian Pleated Wide Trousers',
    brand: 'Meridian',
    description: 'Double-pleated wide leg trousers in a heavy cotton. Falls straight from the hip.',
    category: 'trousers',
    axes: [
      { name: 'waist', values: ['30', '32', '34', '36'] },
      { name: 'colour', values: ['cream', 'brown', 'black'] },
    ],
    basePrice: '2799',
    mrp: '3899',
    deliveryDays: 4,
    weightGrams: 540,
    attributes: { fabric: 'cotton', pleats: 2, fit: 'wide' },
  },
  {
    ref: 'AP-SHIRT-008',
    name: 'Meridian Seersucker Shirt',
    brand: 'Meridian',
    description:
      'Puckered seersucker weave that keeps the fabric off the skin. The coolest shirt in this catalogue, literally.',
    category: 'shirts',
    axes: [
      { name: 'size', values: ['38', '40', '42'] },
      { name: 'colour', values: ['blue-stripe', 'grey-stripe'] },
    ],
    basePrice: '2099',
    mrp: '2999',
    deliveryDays: 4,
    weightGrams: 230,
    attributes: { fabric: 'seersucker', fit: 'regular', sleeve: 'half', pattern: 'stripe' },
  },
];

async function seed(): Promise<void> {
  console.log('Seeding…');

  await db
    .insert(merchants)
    .values([
      {
        id: MERCHANT_ELECTRONICS,
        businessName: 'Kelvin Electronics',
        legalName: 'Kelvin Electronics Private Limited',
        contactEmail: 'orders@kelvin-electronics.example',
        contactPhone: '+919845012345',
        gstin: '29AABCK1234M1Z5',
        gstinVerified: true,
        razorpayAccountId: 'acc_seed_electronics',
        status: 'active',
        categories: ['electronics', 'car-accessories', 'audio'],
        city: 'Bengaluru',
        state: 'Karnataka',
        onboardedAt: new Date('2025-11-04T09:00:00Z'),
      },
      {
        id: MERCHANT_APPAREL,
        businessName: 'Meridian & Aangan',
        legalName: 'Meridian Apparel LLP',
        contactEmail: 'hello@meridian-apparel.example',
        contactPhone: '+919820098765',
        gstin: '27AAFCM5678N1Z2',
        gstinVerified: true,
        razorpayAccountId: 'acc_seed_apparel',
        status: 'active',
        categories: ['apparel', 'shirts', 'kurtas', 'trousers'],
        city: 'Mumbai',
        state: 'Maharashtra',
        onboardedAt: new Date('2025-12-18T09:00:00Z'),
      },
      {
        id: MERCHANT_SERVICES,
        businessName: 'Sabki Seva Home Services',
        legalName: 'Sabki Seva Services Private Limited',
        contactEmail: 'bookings@sabkiseva.example',
        contactPhone: '+919711023456',
        gstin: '07AAGCS9012P1Z8',
        gstinVerified: false,
        razorpayAccountId: 'acc_seed_services',
        status: 'active',
        categories: ['home-services', 'cleaning', 'appliance-service'],
        city: 'Delhi',
        state: 'Delhi',
        onboardedAt: new Date('2026-06-02T09:00:00Z'),
      },
    ])
    .onConflictDoUpdate({
      target: merchants.id,
      set: { businessName: sql`excluded.business_name`, updatedAt: new Date() },
    });

  await db
    .insert(merchantCapabilities)
    .values(
      [MERCHANT_ELECTRONICS, MERCHANT_APPAREL, MERCHANT_SERVICES].map((merchantId) => ({
        merchantId,
        capability: 'catalog',
        enabled: true,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(merchantPolicies)
    .values([
      {
        merchantId: MERCHANT_ELECTRONICS,
        refundUrl: 'https://kelvin-electronics.example/refunds',
        termsUrl: 'https://kelvin-electronics.example/terms',
        fulfillmentUrl: 'https://kelvin-electronics.example/shipping',
        refundSummary:
          'Returns accepted within 7 days of delivery if the item is unused and in its original packaging. Refunds are processed to the original payment method within 5 working days.',
        fulfillmentSummary:
          'Orders placed before 2pm are dispatched the same working day from Bengaluru. Delivery takes 2 to 5 days depending on the pincode.',
        returnWindowDays: 7,
        returnShippingBy: 'merchant',
        dispatchSlaHours: 24,
        lastCheckedAt: new Date(),
        lastCheckStatus: 'ok',
      },
      {
        merchantId: MERCHANT_APPAREL,
        refundUrl: 'https://meridian-apparel.example/returns',
        termsUrl: 'https://meridian-apparel.example/terms',
        fulfillmentUrl: 'https://meridian-apparel.example/delivery',
        refundSummary:
          'Size exchanges are free within 15 days. Refunds are available within 15 days provided tags are intact; the return pickup is arranged by us.',
        fulfillmentSummary:
          'Dispatch within 48 hours of order. Metro delivery in 3 days, rest of India in 5 to 7 days.',
        returnWindowDays: 15,
        returnShippingBy: 'merchant',
        dispatchSlaHours: 48,
        lastCheckedAt: new Date(),
        lastCheckStatus: 'ok',
      },
      {
        merchantId: MERCHANT_SERVICES,
        refundUrl: 'https://sabkiseva.example/cancellation',
        termsUrl: 'https://sabkiseva.example/terms',
        fulfillmentUrl: 'https://sabkiseva.example/service-guarantee',
        refundSummary:
          'Cancel free of charge up to 4 hours before the appointment. Cancellations after that carry a 30 percent fee. Unsatisfactory work is redone at no cost within the warranty period.',
        fulfillmentSummary:
          'Appointments are confirmed by phone within 2 hours of booking. Same-day slots are available before 12pm.',
        returnWindowDays: 0,
        returnShippingBy: 'conditional',
        dispatchSlaHours: 2,
        lastCheckedAt: new Date(),
        lastCheckStatus: 'ok',
      },
    ])
    .onConflictDoNothing();

  /**
   * Metrics normally come from the nightly worker. Seeded here with a deliberate
   * spread so the re-rank tests have something to bite on: an established merchant,
   * a mid-sized one, and one that is genuinely new.
   */
  await db
    .insert(merchantMetrics)
    .values([
      {
        merchantId: MERCHANT_ELECTRONICS,
        ordersTotal: 412,
        ordersFulfilled: 396,
        ordersCancelled: 16,
        onTimeDeliveries: 372,
        avgRating: '4.60',
        ratingCount: 212,
        avgAckMinutes: 38,
        verificationScore: '0.950',
        trustScore: '0.870',
        isNewMerchant: false,
        computedAt: new Date(),
      },
      {
        merchantId: MERCHANT_APPAREL,
        ordersTotal: 138,
        ordersFulfilled: 129,
        ordersCancelled: 9,
        onTimeDeliveries: 118,
        avgRating: '4.30',
        ratingCount: 74,
        avgAckMinutes: 52,
        verificationScore: '0.900',
        trustScore: '0.780',
        isNewMerchant: false,
        computedAt: new Date(),
      },
      {
        merchantId: MERCHANT_SERVICES,
        ordersTotal: 6,
        ordersFulfilled: 6,
        ordersCancelled: 0,
        onTimeDeliveries: 6,
        avgRating: '5.00',
        ratingCount: 4,
        avgAckMinutes: 15,
        verificationScore: '0.600',
        trustScore: '0.520',
        isNewMerchant: true,
        computedAt: new Date(),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(categories)
    .values(
      CATEGORIES.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        path: c.path,
        parentId: c.parent ?? null,
        reviewStatus: 'approved',
      })),
    )
    .onConflictDoNothing();

  // ── SIMPLE products ────────────────────────────────────────────────────────
  let simpleCount = 0;
  for (const [merchantId, items] of [
    [MERCHANT_ELECTRONICS, ELECTRONICS],
    [MERCHANT_SERVICES, SERVICES],
  ] as const) {
    for (const item of items) {
      const [row] = await db
        .insert(products)
        .values({
          merchantId,
          externalRef: item.ref,
          archetype: 'SIMPLE',
          name: item.name,
          brand: item.brand,
          description: item.description,
          categoryId: CAT[item.category] ?? null,
          attributes: item.attributes,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [products.merchantId, products.externalRef],
          set: {
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: products.id });

      if (!row) continue;

      /**
       * A SIMPLE product still gets one variant row. Price and stock live on the
       * variant for every archetype, so nothing downstream needs a special case for
       * "where is the price for a SIMPLE product".
       */
      await db
        .insert(productVariants)
        .values({
          productId: row.id,
          sku: item.ref,
          optionValues: {},
          pricePaise: rupeeStringToPaise(item.price),
          mrpPaise: rupeeStringToPaise(item.mrp),
          stock: item.stock,
          deliveryDays: item.deliveryDays,
          weightGrams: item.weightGrams ?? null,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [productVariants.productId, productVariants.sku],
          set: { pricePaise: sql`excluded.price_paise`, stock: sql`excluded.stock` },
        });

      simpleCount++;
    }
  }

  // ── VARIANT products ───────────────────────────────────────────────────────
  let variantProductCount = 0;
  let variantRowCount = 0;
  for (const item of APPAREL) {
    const [row] = await db
      .insert(products)
      .values({
        merchantId: MERCHANT_APPAREL,
        externalRef: item.ref,
        archetype: 'VARIANT',
        name: item.name,
        brand: item.brand,
        description: item.description,
        categoryId: CAT[item.category] ?? null,
        attributes: item.attributes,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: [products.merchantId, products.externalRef],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: products.id });

    if (!row) continue;
    variantProductCount++;

    await db
      .insert(productOptionAxes)
      .values(
        item.axes.map((axis, i) => ({
          productId: row.id,
          axisName: axis.name,
          axisValues: axis.values,
          displayOrder: i,
        })),
      )
      .onConflictDoNothing();

    for (const combo of cartesian(item.axes)) {
      const suffix = Object.values(combo).join('-').toUpperCase();
      // Larger sizes cost a little more, as they do in a real catalogue.
      const sizeValue = combo.size ?? combo.waist ?? '';
      const surcharge = ['44', '46', '38', '40', 'XL', 'XXL'].includes(sizeValue) ? '100' : '0';
      const price = rupeeStringToPaise(item.basePrice) + rupeeStringToPaise(surcharge);

      await db
        .insert(productVariants)
        .values({
          productId: row.id,
          sku: `${item.ref}-${suffix}`,
          optionValues: combo,
          pricePaise: price,
          mrpPaise: rupeeStringToPaise(item.mrp),
          // A deterministic spread, including some genuine zeroes so the in_stock
          // filter has something to exclude.
          stock: stockFor(`${item.ref}-${suffix}`),
          deliveryDays: item.deliveryDays,
          weightGrams: item.weightGrams,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [productVariants.productId, productVariants.sku],
          set: { pricePaise: sql`excluded.price_paise`, stock: sql`excluded.stock` },
        });
      variantRowCount++;
    }
  }

  console.log(`  merchants          3`);
  console.log(`  categories         ${CATEGORIES.length}`);
  console.log(`  SIMPLE products    ${simpleCount}`);
  console.log(`  VARIANT products   ${variantProductCount}`);
  console.log(`  product_variants   ${simpleCount + variantRowCount}`);
  console.log(`  total products     ${simpleCount + variantProductCount}`);
  console.log(
    '\nsearchable_units is left empty on purpose — the embedding worker (T1.15) owns it.',
  );
}

/** Every combination across the axes, in axis order. */
function cartesian(axes: { name: string; values: string[] }[]): Record<string, string>[] {
  return axes.reduce<Record<string, string>[]>(
    (acc, axis) =>
      acc.flatMap((combo) => axis.values.map((value) => ({ ...combo, [axis.name]: value }))),
    [{}],
  );
}

/** Stable pseudo-random stock from the SKU, so re-seeding does not churn the data. */
function stockFor(sku: string): number {
  let hash = 0;
  for (const ch of sku) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const n = hash % 100;
  return n < 12 ? 0 : n; // roughly one variant in eight is out of stock
}

try {
  await seed();
} finally {
  await client.end();
}
