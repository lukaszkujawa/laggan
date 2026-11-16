// What each exported plant / prop is: how it behaves (cat), how far it is drawn (range),
// and how the scatter pass may densify it (scatter: null = keep the hand-placed count).
const TABLE = [
  // props and ground clutter first ("dead_tree_trunk" / "tree_stump" must not be read as trees)
  [/dead_tree|tree_stump|root_cluster/, { cat: 'debris', range: 'log', scatter: null }],
  [/pine_roots|bark_debris|dry_branches/, { cat: 'debris', range: 'debris', scatter: null }],
  [/^moss_/, { cat: 'moss', range: 'moss', scatter: null }],
  // one-off plants in the Old Schoolhouse garden (hand-placed: never densified)
  [/^garden_(tree|birch)/, { cat: 'tree', range: 'tree', scatter: null }],
  [/^garden_.*bush/, { cat: 'shrub', range: 'shrub', scatter: null }],
  [/^garden_/, { cat: 'small', range: 'small', scatter: null }],
  [/^pine_sapling_medium/, { cat: 'tree', range: 'youngTree', scatter: null }],
  [/sapling/, { cat: 'sapling', range: 'sapling', scatter: null }],
  [/tree/, { cat: 'tree', range: 'tree', scatter: 'tree' }],
  [/^shrub/, { cat: 'shrub', range: 'shrub', scatter: 'shrub' }],
  [/boulder/, { cat: 'rock', range: 'boulder', scatter: null }],
  [/rock|^stone/, { cat: 'rock', range: 'rock', scatter: null }],
  [/nettle|weed_plant|celandine|dandelion|grass_medium_02/, { cat: 'small', range: 'flower', scatter: 'flower' }],
  [/./, { cat: 'small', range: 'small', scatter: 'small' }],
];

export function speciesOf(name) {
  return TABLE.find(([re]) => re.test(name))[1];
}
