/* The packed grid and legacy callbacks use the same ordered motion rule. */
typedef unsigned char byte;
enum { MOVES = 1, TURNS = 2 };
typedef struct {
  int count, min_x, max_x, min_y, max_y, sweeps;
  int coordinates[];
} Hull;
typedef struct {
  double x, y, facing, cx, cy;
} Pose;
typedef struct {
  double speed_x, speed_y;
  int slot;
  Hull *hull;
  int dx, dy, avoid;
} Swimmer;
typedef struct {
  int dx, dy, attempted_turn;
} Trail;
typedef struct {
  int *owners;
  byte *obstacles;
  int width, depth;
} Sea;

__attribute__((import_module("geometry"), import_name("fits"))) int legacy_fits(double x, double y,
                                                                                double facing);
__attribute__((import_module("geometry"), import_name("turns"))) int legacy_turns(double x, double y,
                                                                                  double facing);

static int column(int x, int width) {
  if ((unsigned)x < (unsigned)width) return x;
  x %= width;
  return x < 0 ? x + width : x;
}
static int clear(Sea *sea, int index, int slot, int obstacle) {
  int owner = sea->owners[index];
  return (!owner || owner == slot) && !(sea->obstacles[index] & obstacle);
}
static int fits(Sea *sea, Hull *hull, int slot, double x, double y, double facing) {
  if (!hull) return legacy_fits(x, y, facing);
  int ox = (int)x, oy = (int)y, face = (int)facing;
  if (oy + hull->min_y < 0 || oy + hull->max_y >= sea->depth) return 0;
  for (int i = 0; i < hull->count; i++) {
    int row = oy + hull->coordinates[2 * i + 1],
        col = column(ox + face * hull->coordinates[2 * i], sea->width);
    if (!clear(sea, row * sea->width + col, slot, 1)) return 0;
  }
  return 1;
}
static int turns(Sea *sea, Hull *hull, int slot, double x, double y, double facing) {
  if (!hull) return legacy_turns(x, y, facing);
  int ox = (int)x, oy = (int)y, face = (int)facing;
  if (oy + hull->min_y < 0 || oy + hull->max_y >= sea->depth) return 0;
  int *sweeps = hull->coordinates + 2 * hull->count;
  for (int i = 0; i < hull->sweeps; i++) {
    int row = (oy + sweeps[3 * i + 2]) * sea->width;
    for (int j = sweeps[3 * i]; j <= sweeps[3 * i + 1]; j++)
      if (!clear(sea, row + column(ox + face * j, sea->width), slot, 2)) return 0;
  }
  return 1;
}
static int probe(Sea *sea, Hull *hull, int slot, Pose p, double pivot, int dx, int dy) {
  int flip = dx && dx != p.facing && turns(sea, hull, slot, p.x, p.y, p.facing);
  return (flip ? TURNS : 0) |
         fits(sea, hull, slot, (flip ? pivot : p.x) + dx, p.y + dy, flip ? -p.facing : p.facing);
}
static double capped(double value) { return value > 2 ? 2 : value; }

static Trail advance(Sea *sea, Pose *pose, Swimmer *swimmer, double pivot, double dt, int avoid) {
  const int horizontal[] = {0, 0, -1, 1}, vertical[] = {-1, 1, 0, 0};
  Pose p = *pose;
  Hull *h = swimmer->hull;
  int slot = swimmer->slot, dx = swimmer->dx, dy = swimmer->dy, hx = -1, vy = -1;
  if (avoid && (dx || dy)) {
    if (dx) hx = probe(sea, h, slot, p, pivot, dx, 0);
    if (hx == -1 || !(hx & MOVES)) {
      if (dy) vy = probe(sea, h, slot, p, pivot, 0, dy);
      if (vy == -1 || !(vy & MOVES)) {
        for (int i = 0; i < 4; i++) {
          int direction = (swimmer->avoid + i) & 3, x = horizontal[direction], y = vertical[direction];
          if ((x && x == dx && hx != -1) || (y && y == dy && vy != -1)) continue;
          int result = probe(sea, h, slot, p, pivot, x, y);
          if (!(result & MOVES)) continue;
          dx = x;
          dy = y;
          hx = x ? result : -1;
          vy = y ? result : -1;
          break;
        }
      }
    }
  }
  Trail trail = {.attempted_turn = dx && dx != p.facing};
  if (trail.attempted_turn && (hx == -1 ? turns(sea, h, slot, p.x, p.y, p.facing) : hx & TURNS)) {
    pose->x = pivot;
    pose->facing = -p.facing;
  }
  pose->cx = dx ? capped(p.cx + swimmer->speed_x * dt) : 0;
  pose->cy = dy ? capped(p.cy + swimmer->speed_y * dt) : 0;
  if (pose->cx >= 1 && dx) {
    if (hx == -1 ? fits(sea, h, slot, pose->x + dx, pose->y, pose->facing) : hx & MOVES) {
      pose->x += dx;
      trail.dx = dx;
    }
    pose->cx--;
  }
  if (pose->cy >= 1 && dy) {
    if (vy != -1 && pose->x == p.x && pose->facing == p.facing
            ? vy & MOVES
            : fits(sea, h, slot, pose->x, pose->y + dy, pose->facing)) {
      pose->y += dy;
      trail.dy = dy;
    }
    pose->cy--;
  }
  return trail;
}

static void occupy(Sea *sea, Hull *h, Pose p, int owner) {
  int x = (int)p.x, y = (int)p.y, facing = (int)p.facing;
  for (int i = 0; i < h->count; i++) {
    int row = y + h->coordinates[2 * i + 1], col = column(x + facing * h->coordinates[2 * i], sea->width);
    sea->owners[row * sea->width + col] = owner;
  }
}
void swim(int count, int *owners, byte *obstacles, int width, int depth, Pose *poses, Swimmer *input,
          int *trails, double dt) {
  Sea sea = {owners, obstacles, width, depth};
  for (int i = 0; i < count; i++) {
    Pose *pose = poses + i, before = *pose;
    Swimmer *s = input + i;
    double pivot = before.x + before.facing * (s->hull->min_x + s->hull->max_x);
    Trail trail = advance(&sea, pose, s, pivot, dt, 1);
    pose->x = column((int)pose->x, width);
    trails[i] = (trail.dy + 1) * 3 + trail.dx + 1;
    if (pose->x != before.x || pose->y != before.y || pose->facing != before.facing) {
      occupy(&sea, s->hull, before, 0);
      occupy(&sea, s->hull, *pose, s->slot);
    }
  }
}
int swim_one(Pose *pose, double pivot, double dt, double speed_x, double speed_y, int dx, int dy, int offset,
             int avoid) {
  Swimmer s = {.speed_x = speed_x, .speed_y = speed_y, .dx = dx, .dy = dy, .avoid = offset};
  Trail t = advance((Sea *)0, pose, &s, pivot, dt, avoid);
  return ((t.dy + 1) * 3 + t.dx + 1) | (t.attempted_turn ? 16 : 0);
}
_Static_assert(sizeof(Pose) == 40 && sizeof(Swimmer) == 40, "Update the worker column layout");
