typedef unsigned char byte;
typedef unsigned int word;

void density_prefix(word *totals, const int *owners, const byte *occupied, const double *floors, int width,
                    int height, word scale) {
  const int stride = width + 1;
  for (int x = 0; x <= width; x++) totals[x] = 0;
  for (int y = 0; y < height; y++) {
    const int base = y * width;
    word row = 0, *out = totals + (y + 1) * stride;
    out[0] = 0;
    for (int x = 0; x < width; x++) {
      const int cell = base + x;
      if (y < floors[x]) row += 1 + (occupied[cell] || (owners && owners[cell]) ? scale : 0);
      out[x + 1] = out[x + 1 - stride] + row;
    }
  }
}

static word window(const word *top, const word *bottom, int x, int width, int r) {
  int left = x - r, right = x + r + 1;
  if (left < 0)
    return bottom[width] - top[width] + bottom[right] - top[right] - bottom[left + width] + top[left + width];
  if (right > width)
    return bottom[width] - top[width] + bottom[right - width] - top[right - width] - bottom[left] + top[left];
  return bottom[right] - top[right] - bottom[left] + top[left];
}

static int opposite(const byte *sex, int a, int b) { return (sex[a] | sex[b]) == 3; }
static double ordered_pair(byte first, int a, int b, int count) {
  return first == 1 ? (double)a * count + b : (double)b * count + a;
}

// Emit in the same left, upper, descending-diagonal, ascending-diagonal order for every midpoint.
int adjacent_pairs(const int *owners, const byte *sex, const byte *walls, const word *totals, int width,
                   int height, int radius, word scale, int slot_count, int first_row, int end_row,
                   double *pairs, int numerator, int denominator) {
  double *out = pairs;
  for (int y = first_row; y < end_row; y++) {
    int top_y = y < radius ? 0 : y - radius, bottom_y = y + radius + 1 < height ? y + radius + 1 : height;
    const word *top = totals ? totals + top_y * (width + 1) : 0,
               *bottom = totals ? totals + bottom_y * (width + 1) : 0;
    int left_cell = (y + 1) * width - 1, upper_left_cell = left_cell - width;
    int left = owners[left_cell], diagonal = y ? owners[upper_left_cell] : 0;
    for (int x = 0; x < width; x++) {
      const int cell = y * width + x, upper_cell = cell - width;
      int here = owners[cell], up = y ? owners[upper_cell] : 0;
      if ((sex[here] | sex[left] | sex[up] | sex[diagonal]) == 3) {
        if (!pairs) return 1;
        word area = !totals || top_y > bottom_y ? 0 : window(top, bottom, x, width, radius);
        if (!totals || (area / scale) * denominator < (area % scale) * numerator) {
          if (opposite(sex, left, here)) *out++ = ordered_pair(sex[left], left, here, slot_count);
          if (opposite(sex, up, here)) *out++ = ordered_pair(sex[up], up, here, slot_count);
          if (opposite(sex, diagonal, here) && !walls[left_cell] && !walls[upper_cell])
            *out++ = ordered_pair(sex[diagonal], diagonal, here, slot_count);
          if (opposite(sex, left, up) && !walls[upper_left_cell] && !walls[cell])
            *out++ = ordered_pair(sex[left], left, up, slot_count);
        }
      }
      left_cell = cell;
      upper_left_cell = upper_cell;
      left = here;
      diagonal = up;
    }
  }
  return pairs ? (int)(out - pairs) : 0;
}
static int wrap(int x, int width) { return (unsigned)x < (unsigned)width ? x : (x % width + width) % width; }
// The first unobstructed contact follows the glyph order chosen by the breeding rules.
int canonical_midpoint(const byte *walls, int width, const int *male, int nm, int mx, int my, int mf,
                       const int *female, int nf, int fx, int fy, int ff) {
  for (int i = 0; i < nm; i++) {
    int px = mx + mf * male[2 * i], py = my + male[2 * i + 1];
    for (int j = 0; j < nf; j++) {
      int dy = fy + female[2 * j + 1] - py;
      if (dy < -1 || dy > 1) continue;
      int dx = fx + ff * female[2 * j] - px;
      if (dx < -1 || dx > 1) {
        dx = wrap(dx + width / 2, width) - width / 2;
        if (dx < -1 || dx > 1) continue;
      }
      if (!dx && !dy) continue;
      if (dx && dy &&
          (walls[(py + dy) * width + wrap(px, width)] || walls[py * width + wrap(px + dx, width)]))
        continue;
      return (py + (dy > 0)) * width + wrap(px + (dx > 0), width);
    }
  }
  return -1;
}
